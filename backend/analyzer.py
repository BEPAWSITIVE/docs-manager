import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from google import genai
from google.genai import types

from backend.config import DEFAULT_MODEL
from backend.database import fallback_keyword_search


def _clean_json_response(raw_text: str) -> str:
    """Removes markdown code fences and cleans text to extract JSON."""
    raw_text = raw_text.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw_text)
    if match:
        return match.group(1).strip()
    return raw_text


def validate_api_key(api_key: str, model_name: str = DEFAULT_MODEL) -> bool:
    """Tests if a Gemini API key is valid by making a lightweight call."""
    if not api_key or not api_key.strip():
        return False
    try:
        client = genai.Client(api_key=api_key.strip())
        response = client.models.generate_content(
            model=model_name,
            contents="Respond with 'OK'",
        )
        return bool(response and response.text)
    except Exception:
        return False


def analyze_document(
    file_path: Path,
    mime_type: str,
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Dict[str, Any]:
    """
    Analyzes an uploaded document image or PDF using Gemini.
    Extracts document type, cardholder name, document ID, issuing organization, and keywords.
    """
    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()

    default_fallback = {
        "document_type": file_path.stem.replace("_", " ").title(),
        "person_name": "",
        "document_number": "",
        "issuing_authority": "",
        "dob": "",
        "searchable_keywords": [file_path.stem.lower()],
        "short_summary": f"Uploaded document: {file_path.name}",
    }

    if not effective_key:
        return default_fallback

    try:
        client = genai.Client(api_key=effective_key)

        with open(file_path, "rb") as f:
            file_bytes = f.read()

        is_visual = (
            mime_type.startswith("image/")
            or mime_type in ["application/pdf"]
            or file_path.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp", ".pdf", ".bmp"]
        )

        base_instructions = (
            "You are an expert document classifier and OCR metadata extractor. "
            "Examine this document or file thoroughly. "
            "Identify what exact document/file it is (e.g., Aadhar Card, PAN Card, College ID Card, "
            "Project Proposal, Invoice, Resume, Contract, Driver's License, Passport, Marksheet, etc.).\n\n"
            "Extract:\n"
            "1. document_type: Clean document/file category name (e.g. 'Aadhar Card', 'Project Proposal', 'College ID', etc.)\n"
            "2. person_name: Full name of the individual or author it belongs to, or empty string.\n"
            "3. document_number: Identification or registration number if present, or empty string.\n"
            "4. issuing_authority: Organization, company, or institution that issued it, or empty string.\n"
            "5. dob: Date of birth or creation date if visible, or empty string.\n"
            "6. searchable_keywords: Array of all relevant search keywords (include filename, names, titles, variations, abbreviations).\n"
            "7. short_summary: A 1-sentence concise description.\n\n"
            "Return STRICTLY a JSON object with this exact structure:\n"
            "{\n"
            '  "document_type": string,\n'
            '  "person_name": string,\n'
            '  "document_number": string,\n'
            '  "issuing_authority": string,\n'
            '  "dob": string,\n'
            '  "searchable_keywords": string[],\n'
            '  "short_summary": string\n'
            "}"
        )

        contents_payload = []
        if is_visual:
            try:
                clean_mime = mime_type if mime_type and "/" in mime_type else "image/jpeg"
                file_part = types.Part.from_bytes(data=file_bytes, mime_type=clean_mime)
                contents_payload = [file_part, base_instructions]
            except Exception:
                is_visual = False

        if not is_visual:
            ext = file_path.suffix.lower()
            sample_text = ""
            if ext in [".txt", ".csv", ".json", ".md", ".log", ".xml", ".html", ".py", ".js"]:
                sample_text = file_bytes.decode("utf-8", errors="ignore")[:6000]
            elif ext == ".docx":
                try:
                    import docx
                    doc_obj = docx.Document(file_path)
                    sample_text = "\n".join([p.text for p in doc_obj.paragraphs if p.text])[:6000]
                except Exception:
                    sample_text = file_bytes.decode("utf-8", errors="ignore")[:4000]
            else:
                sample_text = f"File: {file_path.name}, Size: {len(file_bytes)} bytes."

            text_prompt = f"Filename: {file_path.name}\nExtracted Content:\n{sample_text}\n\n{base_instructions}"
            contents_payload = [text_prompt]

        response = client.models.generate_content(
            model=model_name,
            contents=contents_payload,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.1,
            ),
        )

        if response and response.text:
            cleaned = _clean_json_response(response.text)
            parsed = json.loads(cleaned)
            # Ensure searchable_keywords is a list
            keywords = parsed.get("searchable_keywords", [])
            if isinstance(keywords, str):
                keywords = [k.strip() for k in keywords.split(",")]
            parsed["searchable_keywords"] = keywords
            return parsed

    except Exception as e:
        print(f"[analyzer.analyze_document] Error: {e}")

    return default_fallback


def find_matching_document(
    query: str,
    documents: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Optional[Dict[str, Any]]:
    """
    Uses Gemini to intelligently match a natural language query
    (e.g. 'give me Deepak Aadhar card' or 'my college id')
    against candidate document metadata in the database.
    """
    if not documents:
        return None

    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()

    # If Gemini is available, use LLM-based intelligent semantic match
    if effective_key:
        try:
            client = genai.Client(api_key=effective_key)

            # Compact summary of candidates
            candidates = []
            for doc in documents:
                analysis = doc.get("analysis", {})
                candidates.append({
                    "doc_id": doc.get("doc_id"),
                    "document_type": analysis.get("document_type"),
                    "person_name": analysis.get("person_name"),
                    "document_number": analysis.get("document_number"),
                    "issuing_authority": analysis.get("issuing_authority"),
                    "searchable_keywords": analysis.get("searchable_keywords", []),
                    "original_filename": doc.get("original_filename"),
                })

            prompt = (
                f"User request: '{query}'\n\n"
                f"Candidate documents in database:\n"
                f"{json.dumps(candidates, indent=2)}\n\n"
                "Task: Determine which single document ID best matches the user's request. "
                "Carefully consider the person's name and document type (e.g. Aadhar, PAN, College ID). "
                "If no document matches with clear confidence, return null.\n"
                "Return STRICTLY a JSON object with this key:\n"
                '{"matched_doc_id": "<doc_id>" or null}'
            )

            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.0,
                ),
            )

            if response and response.text:
                cleaned = _clean_json_response(response.text)
                result = json.loads(cleaned)
                matched_id = result.get("matched_doc_id")
                if matched_id:
                    for doc in documents:
                        if doc.get("doc_id") == matched_id:
                            return doc
        except Exception as e:
            print(f"[analyzer.find_matching_document] LLM match error: {e}")

    # Fallback to deterministic keyword matching
    return fallback_keyword_search(query)
