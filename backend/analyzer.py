import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from google import genai
from google.genai import types

from backend.config import DEFAULT_MODEL

# Fastest, most reliable and active models on Google AI Studio
FALLBACK_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
]

_client_cache: Dict[str, genai.Client] = {}


def get_genai_client(api_key: str) -> genai.Client:
    """
    Returns a cached Gemini client with tenacity retries disabled (attempts=1).
    This ensures that quota (429) or transient errors fail immediately (in <0.5s)
    so our fallback logic can instantly try the next model without hitting Vercel timeouts.
    """
    cleaned_key = api_key.strip()
    if cleaned_key not in _client_cache:
        http_opts = types.HttpOptions(
            retry_options=types.HttpRetryOptions(attempts=1)
        )
        _client_cache[cleaned_key] = genai.Client(api_key=cleaned_key, http_options=http_opts)
    return _client_cache[cleaned_key]


def _get_model_candidates(preferred: Optional[str] = None) -> List[str]:
    """
    Generates an ordered list of candidate models.
    Prioritizes active, quota-safe models (gemini-3.5-flash-lite).
    """
    candidates = []
    # If preferred model is in our verified working models list, honor it
    if preferred and preferred.strip() in FALLBACK_MODELS:
        candidates.append(preferred.strip())
    # Always include verified models
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
        client = get_genai_client(api_key)
        candidate_model = model_name if model_name in FALLBACK_MODELS else DEFAULT_MODEL
        response = client.models.generate_content(
            model=candidate_model,
            contents="Respond with 'OK'",
        )
        return bool(response and response.text)
    except Exception:
        return False


def analyze_document(
    file_bytes: Optional[bytes] = None,
    file_path: Optional[Path] = None,
    mime_type: str = "application/octet-stream",
    filename: str = "document",
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Dict[str, Any]:
    """
    Analyzes an uploaded document image or PDF directly using Gemini Multimodal AI.
    Extracts structured metadata: document type, person name, document ID, issuing organization, and keywords.
    """
    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()

    stem_name = Path(filename).stem
    default_fallback = {
        "document_type": stem_name.replace("_", " ").title(),
        "person_name": "",
        "document_number": "",
        "phone_number": "",
        "issuing_authority": "",
        "dob": "",
        "searchable_keywords": [stem_name.lower()],
        "short_summary": f"Uploaded document: {filename}",
    }

    if not effective_key:
        return default_fallback

    # Read bytes from file_path if file_bytes not provided directly
    if file_bytes is None and file_path is not None:
        try:
            with open(file_path, "rb") as f:
                file_bytes = f.read()
        except Exception:
            return default_fallback

    if not file_bytes:
        return default_fallback

    try:
        client = get_genai_client(effective_key)

        is_visual = (
            mime_type.startswith("image/")
            or mime_type in ["application/pdf"]
            or any(filename.lower().endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp", ".pdf", ".bmp"])
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
            "3. Personal ID & Invoices: Accurately extract person_name, ID numbers, phone number, issue date / DOB, and organization.\n"
            "4. Searchable Keywords: Array of all relevant search keywords including document type variations, "
            "transliterations ('aadhar', 'adhar', 'aadhaar', 'pan'), person names, company names, key offerings, and filename terms.\n\n"
            "Return STRICTLY a JSON object with this exact structure:\n"
            "{\n"
            '  "document_type": string,\n'
            '  "person_name": string,\n'
            '  "document_number": string,\n'
            '  "phone_number": string,\n'
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
            sample_text = file_bytes.decode("utf-8", errors="ignore")[:6000]
            text_prompt = f"Filename: {filename}\nExtracted Content:\n{sample_text}\n\n{base_instructions}"
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
                    filename_tokens = [w.lower() for w in re.findall(r"\w+", stem_name) if len(w) > 2]
                    keywords.extend(filename_tokens)
                    keywords.append(stem_name.lower())
                    parsed["searchable_keywords"] = list(dict.fromkeys(keywords))
                    return parsed
            except Exception as model_err:
                print(f"[analyzer.analyze_document] Model '{current_model}' failed: {model_err}. Trying fallback...")
                continue

    except Exception as e:
        print(f"[analyzer.analyze_document] Error: {e}")

    return default_fallback


def conversational_document_retrieval(
    query: str,
    documents: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Dict[str, Any]:
    """
    Intelligently analyzes a natural language query or conversation from WhatsApp/Web.
    - Understands user intent (document request, greeting, questions, list inquiry).
    - Enforces STRICT matching: BOTH person name and document type must match.
    - ZERO-HALLUCINATION / ZERO-SUBSTITUTION: If a user asks for 'Rahul land certificate'
      and we only have 'Rahul birth certificate', it will NEVER return the birth certificate!
      Instead, it replies conversationally and professionally, informing the user what is on file.
    - Generates a courteous, professional conversational reply for every situation.
    """
    default_res = {
        "intent": "document_request",
        "matched_doc_id": None,
        "matched_doc": None,
        "requested_person": None,
        "requested_doc_type": None,
        "professional_reply": "I searched our records, but could not find the requested document.",
    }

    clean_query = str(query or "").strip()
    if not clean_query:
        default_res["professional_reply"] = "How may I assist you with your documents today?"
        return default_res

    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if not effective_key:
        print("[analyzer.conversational_document_retrieval] Missing GEMINI_API_KEY")
        return default_res

    # Prepare candidate metadata list from Supabase
    candidates = []
    for doc in (documents or []):
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

    prompt = f"""You are the official, professional AI Document Assistant for 'Docs Manager' communicating directly with a verified client on WhatsApp.

User's incoming message: "{clean_query}"

Available stored documents in the cloud vault:
{json.dumps(candidates, indent=2, ensure_ascii=False)}

Your Objectives:
1. Understand the user's intent:
   - "document_request": The user is asking to retrieve/find a document (e.g., "Give me Rahul's land certificate", "Shivam ka aadhar dena", "electricity bill bhejo").
   - "list_inquiry": The user is asking what documents exist for a person or in the vault (e.g., "What documents do you have for Rahul?", "Rahul ke kaunse docs hain?").
   - "general_chat": Greetings, general assistance, or questions about how to use the service (e.g., "Hi", "Hello", "How do I use this?", "Who are you?").
   - "clarification_needed": The user asked for a vague document where multiple different people or candidates exist, and you need to clarify who they mean.

2. STRICT DOCUMENT MATCHING & ANTI-HALLUCINATION RULES:
   - BOTH the Person's Name AND the Document Type MUST match with high confidence.
   - ZERO SUBSTITUTION RULE:
     * If the user asks for a "Land Certificate" (or Jamabandi, Land Map, Khasra, Registry, Khatauni) for Rahul, but the vault only has a "Birth Certificate" or "Electricity Bill" for Rahul:
       matched_doc_id MUST BE null!
     * NEVER return a Birth Certificate, Aadhaar Card, or Bill when a Land Certificate was requested.
     * NEVER return a document belonging to a different person (e.g., never return Shivam's or Pratap's document for Rahul).
   - If a file contains multiple cards/documents (e.g., "Aadhaar Card and PAN Card"), it is a valid match if the user asks for either card for that person.
   - If matched, set "matched_doc_id" to the document's doc_id. If not matched, "matched_doc_id" MUST be null.

3. PROFESSIONAL CONVERSATIONAL RESPONSE ("professional_reply"):
   - Formulate a polite, professional, and helpful response suitable for business WhatsApp communication.
   - Maintain the user's language (English, Hindi, or Hinglish).
   - If a document is MATCHED:
     Provide a courteous, brief delivery message indicating the exact document being provided (e.g., "Here is the Birth Certificate for Rahul that you requested." / "नमस्ते, राहुल का जन्म प्रमाण पत्र यहाँ संलग्न है।").
   - If a document is NOT FOUND, but OTHER documents exist for that person:
     Politely explain that the requested document type was not found, mention what document(s) ARE currently available for that person, and ask how they would like to proceed.
     (e.g., "I searched our records for a Land Certificate for Rahul, but could not find one on file. However, we currently have Rahul's Birth Certificate in the vault. Would you like me to share that instead?")
   - If NO records exist at all for that person/query:
     Politely inform the user that no matching records were found, and offer assistance (e.g., "I checked our records, but could not find any documents for [Name]. Please verify the name or feel free to upload the document here if you'd like it indexed.").
   - If GREETING or GENERAL INQUIRY:
     Welcome the user professionally, explain what Docs Manager can do (securely store documents, extract details, and retrieve them anytime), and offer to assist.
   - If LISTING DOCUMENTS:
     List the available documents for the person neatly in bullet points and ask if they'd like any sent.

Return STRICTLY a JSON object with this exact schema:
{{
  "intent": "document_request" | "list_inquiry" | "general_chat" | "clarification_needed",
  "matched_doc_id": string or null,
  "requested_person": string or null,
  "requested_doc_type": string or null,
  "professional_reply": string
}}
"""

    models_to_try = _get_model_candidates(model_name)
    client = get_genai_client(effective_key)

    for current_model in models_to_try:
        try:
            response = client.models.generate_content(
                model=current_model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                ),
            )

            if response and response.text:
                cleaned = _clean_json_response(response.text)
                result = json.loads(cleaned)
                matched_id = result.get("matched_doc_id")
                matched_doc = None
                if matched_id:
                    for doc in documents:
                        if doc.get("doc_id") == matched_id:
                            matched_doc = doc
                            break

                return {
                    "intent": result.get("intent", "document_request"),
                    "matched_doc_id": matched_id if matched_doc else None,
                    "matched_doc": matched_doc,
                    "requested_person": result.get("requested_person"),
                    "requested_doc_type": result.get("requested_doc_type"),
                    "professional_reply": result.get("professional_reply") or "I could not find the requested document.",
                }
        except Exception as model_err:
            print(f"[analyzer.conversational_document_retrieval] Model '{current_model}' failed: {model_err}. Trying fallback...")
            continue

    return default_res


def find_matching_document(
    query: str,
    documents: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    model_name: str = DEFAULT_MODEL,
) -> Optional[Dict[str, Any]]:
    """
    Backwards-compatible wrapper that returns the matched document dictionary or None.
    Uses conversational_document_retrieval internally.
    """
    res = conversational_document_retrieval(
        query=query,
        documents=documents,
        api_key=api_key,
        model_name=model_name,
    )
    return res.get("matched_doc")
