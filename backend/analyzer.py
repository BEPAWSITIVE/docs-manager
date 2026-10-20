import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from google import genai
from google.genai import types

from backend.config import DEFAULT_MODEL
from backend.database import fallback_keyword_search

FALLBACK_MODELS = [
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
]


def _get_model_candidates(preferred: Optional[str] = None) -> List[str]:
    """Generates an ordered list of candidate models for fallback tolerance."""
    candidates = []
    if preferred and preferred.strip():
        candidates.append(preferred.strip())
    for m in FALLBACK_MODELS:
        if m not in candidates:
            candidates.append(m)
    return candidates


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
    Supports multi-document files (e.g. Aadhaar + PAN), promotional posters/banners, etc.
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
            "You are an expert document classifier and OCR metadata extractor.\n"
            "Examine this document, image, or file thoroughly.\n\n"
            "Key instructions:\n"
            "1. Multi-document detection: If this file contains multiple documents or cards (for example: "
            "both an Aadhaar Card AND a PAN Card in the same PDF/image), explicitly classify document_type as "
            "'Aadhaar Card and PAN Card' (or similar combo), and ensure searchable_keywords includes BOTH card types.\n"
            "2. Promotional Posters / Banners / Ads: If this is a promotional banner, offer poster, advertisement, "
            "or flyer (e.g. 'Precision Optics Offer Banner', discounts, eyewear, retail poster), classify document_type "
            "appropriately (e.g. 'Promotional Banner' or 'Offer Poster'), extract the store/business name into "
            "issuing_authority, and include all prominent keywords (e.g. 'precision optics', 'banner', 'poster', 'offer', discounts).\n"
            "3. Personal ID & Invoices: Accurately extract person_name, ID numbers, issue date / DOB, and organization.\n"
            "4. Searchable Keywords: Array of all relevant search keywords including document type variations, "
            "transliterations ('aadhar', 'adhar', 'aadhaar', 'pan'), person names, company names, key offerings, and filename terms.\n\n"
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

        models_to_try = _get_model_candidates(model_name)
        for current_model in models_to_try:
            try:
                response = client.models.generate_content(
                    model=current_model,
                    contents=contents_payload,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.1,
                    ),
                )

                if response and response.text:
                    cleaned = _clean_json_response(response.text)
                    parsed = json.loads(cleaned)
                    keywords = parsed.get("searchable_keywords", [])
                    if isinstance(keywords, str):
                        keywords = [k.strip() for k in keywords.split(",")]
                    # Include stem tokens from original filename
                    filename_tokens = [w.lower() for w in re.findall(r"\w+", file_path.stem) if len(w) > 2]
                    keywords.extend(filename_tokens)
                    keywords.append(file_path.stem.lower())
                    parsed["searchable_keywords"] = list(dict.fromkeys(keywords))
                    return parsed
            except Exception as model_err:
                print(f"[analyzer.analyze_document] Model '{current_model}' failed: {model_err}. Trying fallback...")
                continue

    except Exception as e:
        print(f"[analyzer.analyze_document] Fatal error: {e}")

    return default_fallback


def find_matching_document(
    query: str,
    documents: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Optional[Dict[str, Any]]:
    """
    Uses Gemini to intelligently match a natural language query
    (e.g. 'give me Deepak Aadhar card' or 'precision optics banner')
    against candidate document metadata in the database.
    Falls back gracefully to other models and to keyword search on complete failure.
    """
    if not documents:
        return None

    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()

    # If Gemini is available, use LLM-based intelligent semantic match
    if effective_key:
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
                "short_summary": analysis.get("short_summary"),
                "original_filename": doc.get("original_filename"),
            })

        prompt = (
            f"User request: '{query}'\n\n"
            f"Candidate documents in database:\n"
            f"{json.dumps(candidates, indent=2)}\n\n"
            "Task: Determine which single document ID best matches the user's request.\n"
            "Rules:\n"
            "1. Match carefully on person name, document type (e.g. Aadhaar, PAN, College ID, Quotation, Resume), company/brand name, and filename.\n"
            "2. Multi-card / Multi-doc files: If a file contains multiple documents (e.g. 'Aadhaar Card and PAN Card' or 'adhar and pan.pdf'), "
            "it matches requests for EITHER card type (e.g. 'aadhar' or 'pan').\n"
            "3. Person Name Strictness: If the user asks for a document belonging to person A (e.g. 'Deepak ka aadhar'), "
            "and a candidate belongs to person B (e.g. 'Kabeer' or 'John'), DO NOT match person B's document! Return null instead.\n"
            "4. Marketing / Banners / Posters: If the user asks for 'precision optics banner' or 'offer poster', match the relevant marketing document or banner.\n"
            "5. If no candidate document matches the user's request with clear confidence, return null for matched_doc_id.\n\n"
            "Return STRICTLY a JSON object with this key:\n"
            '{"matched_doc_id": "<doc_id>" or null}'
        )

        models_to_try = _get_model_candidates(model_name)
        for current_model in models_to_try:
            try:
                client = genai.Client(api_key=effective_key)
                response = client.models.generate_content(
                    model=current_model,
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
                    # If Gemini explicitly answered that no document matched, return None!
                    # Do NOT fall through to keyword search when the LLM deliberately said null.
                    return None
            except Exception as model_err:
                print(f"[analyzer.find_matching_document] Model '{current_model}' failed: {model_err}. Trying fallback...")
                continue

    # Fallback to deterministic keyword matching only if LLM is unavailable or all models failed
    return fallback_keyword_search(query)
