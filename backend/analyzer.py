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
        "father_or_spouse_name": "",
        "document_number": "",
        "additional_identifiers": "",
        "phone_number": "",
        "issuing_authority": "",
        "dob": "",
        "key_dates": "",
        "address_or_location": "",
        "financial_amount": "",
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
            "You are an expert multilingual document classifier, OCR engine, and metadata extractor.\n"
            "Examine this document, image, or PDF thoroughly. Capture ALL important data into structured metadata "
            "so that any user searching by person name, relative name, document number, location, date, or document type "
            "can find it effortlessly in the future.\n\n"
            "Key Extraction Instructions:\n"
            "1. Document Type: Classify precisely (e.g. 'Aadhaar Card', 'PAN Card', 'Jamabandi / Land Record', "
            "'Land Survey Map', 'Electricity Bill', 'Driving License', 'Passport', 'Birth Certificate', "
            "'Agriculturist Certificate', 'Bank Statement', 'Marksheet', 'Rent Agreement', 'Invoice', 'Promotional Banner'). "
            "If multi-document (e.g. Aadhaar + PAN in one file), explicitly state 'Aadhaar Card and PAN Card'.\n"
            "2. Primary Person Name: Full legal name of the cardholder, consumer, or owner. Include both English and Hindi spellings if visible.\n"
            "3. Father / Spouse / Relative Name: Extract Father's Name, Husband's Name, S/O, D/O, W/O, C/O if printed.\n"
            "4. Document Number / Primary ID: The primary official identifier (e.g. 12-digit Aadhaar, 10-char PAN, License No, Passport No, Bill CA No).\n"
            "5. Additional Identifiers: Secondary numbers like Khasra No, Khata No, Khewat No, Jamabandi No, Consumer No, Meter No, Roll No, Account No.\n"
            "6. Key Dates: Date of Birth (DOB), issue date, validity/expiry date, billing period, due date, registration date.\n"
            "7. Address & Location: Village, Mauza, Tehsil, District, City, State, PIN code, or landmark mentioned.\n"
            "8. Issuing Authority: Official issuing department, ministry, or company (e.g. UIDAI, Income Tax Department, Revenue Department, BSES, State Government, Bank).\n"
            "9. Phone Number: Any contact phone or mobile number printed on the document.\n"
            "10. Financial / Numeric Specifics: Bill payable amount, land area/kitta measurement, fee, or property value if applicable.\n"
            "11. Searchable Keywords: Comprehensive array of 15-30 search keywords including:\n"
            "    - Person name variations (first, last, full, both English and Hindi spellings)\n"
            "    - Father/Spouse name\n"
            "    - Document type in English, Hindi, and Hinglish (e.g. 'aadhar', 'adhar', 'aadhaar', 'pan card', 'jamabandi', 'nakal', 'bijli bill', 'electricity bill', 'khasra', 'khatauni')\n"
            "    - All ID numbers and partial numbers\n"
            "    - Village, Tehsil, District, State names\n"
            "    - Issuing authority name\n"
            "12. Short Summary: A dense, 2-3 sentence factual summary capturing all critical facts: document type, primary person, relative, ID number, location, and key dates.\n\n"
            "Return STRICTLY a JSON object with this exact structure:\n"
            "{\n"
            '  "document_type": string,\n'
            '  "person_name": string,\n'
            '  "father_or_spouse_name": string,\n'
            '  "document_number": string,\n'
            '  "additional_identifiers": string,\n'
            '  "phone_number": string,\n'
            '  "issuing_authority": string,\n'
            '  "dob": string,\n'
            '  "key_dates": string,\n'
            '  "address_or_location": string,\n'
            '  "financial_amount": string,\n'
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


def strip_greetings(text: str) -> str:
    """Guarantees strictly zero greetings in assistant messages (both English, Hinglish and Hindi)."""
    if not text:
        return ""
    cleaned = text.strip()
    # Strip English and Roman Hinglish greetings
    cleaned = re.sub(
        r"^(?:hello|hi|hii|hiii|hey|heyy|namaste|namaskar|pranam|greetings|dear|good\s+(?:morning|afternoon|evening))\s*[,!.:-]*\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    # Strip Devanagari Hindi greetings
    cleaned = re.sub(
        r"^(?:नमस्ते|नमस्कार|प्रणाम|सुप्रभात|शुभ\s+संध्या|हाय|हेलो)\s*[,!.:-]*\s*",
        "",
        cleaned,
    ).strip()
    if cleaned and cleaned[0].islower():
        cleaned = cleaned[0].upper() + cleaned[1:]
    return cleaned


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

    # Instant sub-millisecond response for standard greetings and common polite messages
    clean_lower = clean_query.lower().strip("!.?, ")
    if clean_lower in [
        "hi", "hii", "hiii", "hello", "hey", "heyy", "namaste", "namaskar", "pranam",
        "kaise ho", "kya haal hai", "good morning", "good afternoon", "good evening", "help",
        "start", "menu"
    ]:
        default_res["intent"] = "general_chat"
        is_hinglish_greeting = any(w in clean_lower for w in ["namaste", "namaskar", "pranam", "kaise", "haal", "kya"])
        if is_hinglish_greeting:
            default_res["professional_reply"] = (
                "Docs Assistant ready hai. Batayein kaunsa document chahiye (jaise Deepak ka PAN card ya Rahul ka electricity bill)."
            )
        else:
            default_res["professional_reply"] = (
                "Docs Assistant ready. Please specify which document you need (e.g. Deepak PAN card or Rahul electricity bill)."
            )
        return default_res

    effective_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if not effective_key:
        print("[analyzer.conversational_document_retrieval] Missing GEMINI_API_KEY")
        return default_res

    # Prepare concise candidate metadata list for ultra-fast LLM inference
    compact_candidates = []
    for doc in (documents or []):
        analysis = doc.get("analysis", {})
        doc_type = analysis.get("document_type") or doc.get("document_type") or "Document"
        name = analysis.get("person_name") or doc.get("person_name") or ""
        father = analysis.get("father_or_spouse_name") or ""
        doc_no = analysis.get("document_number") or doc.get("document_number") or ""
        add_ids = analysis.get("additional_identifiers") or ""
        auth = analysis.get("issuing_authority") or doc.get("issuing_authority") or ""
        location = analysis.get("address_or_location") or ""
        summary = analysis.get("short_summary") or doc.get("short_summary") or ""

        info = f"- ID: {doc.get('doc_id')} | Type: {doc_type}"
        if name:
            info += f" | Person: {name}"
        if father:
            info += f" | Rel: {father}"
        if doc_no:
            info += f" | No: {doc_no}"
        if add_ids:
            info += f" | ExtraID: {add_ids}"
        if auth:
            info += f" | Auth: {auth}"
        if location:
            info += f" | Loc: {location}"
        if summary:
            info += f" | Details: {summary[:100]}"
        compact_candidates.append(info)

    candidates_summary = "\n".join(compact_candidates)

    prompt = f"""You are the official, helpful AI Document Assistant for 'Docs Manager' communicating directly with a verified user on WhatsApp.

User's incoming message: "{clean_query}"

Available stored documents in the cloud vault:
{candidates_summary}

Your Objectives & Strict Rules:
1. Understand the user's intent:
   - "document_request": User is asking to retrieve/find a document (e.g., "Give me Rahul's land certificate", "Shivam ka aadhar dena", "electricity bill bhejo", "sayd pancard tha").
   - "list_inquiry": User is asking what documents exist for a person or in the vault (e.g., "What documents do you have for Rahul?", "Rahul ke kaunse docs hain?", "kya kya docs hain").
   - "general_chat": Inquiries about system capabilities or how to find files.
   - "clarification_needed": User asked for a document where multiple persons exist and it's unclear who they want.

2. STRICT DOCUMENT MATCHING & ANTI-HALLUCINATION RULES:
   - BOTH the Person's Name AND the Document Type MUST match with high confidence.
   - ZERO SUBSTITUTION RULE:
     * If user asks for "Land Certificate" (or Jamabandi, Land Map, Khasra, Registry, Khatauni) for Rahul, but vault only has "Birth Certificate" or "Electricity Bill" for Rahul:
       matched_doc_id MUST BE null!
     * NEVER return a Birth Certificate, Aadhaar Card, or Bill when a Land Certificate was requested.
     * NEVER return a document belonging to a different person (e.g., never return Shivam's or Pratap's document for Rahul).
   - If a file contains multiple cards/documents (e.g., "Aadhaar Card and PAN Card"), it is a valid match if user asks for either card for that person.
   - If matched, set "matched_doc_id" to the document's doc_id. If not matched, "matched_doc_id" MUST be null.

3. CONVERSATIONAL TONE & LANGUAGE MATCHING (CRITICAL):
   - STRICTLY ZERO GREETINGS:
     DO NOT start messages with greetings like "Hello", "Hi", "Hii", "Namaste", "Pranam", "Greetings", "Dear", "Good morning/evening", or "नमस्ते".
     Jump directly and immediately into the helpful answer!
   - HINGLISH & LANGUAGE MIRRORING:
     * If the user writes in HINGLISH (e.g. "Mujhe aadhar card chahiye", "deepak ka pan card dena", "shivam ke kya docs hain", "sayd pancard tha", "bhejo", "chahiye", "nahi mila", "kaunse"), you MUST reply in natural, fluent, friendly HINGLISH in Latin/English characters!
     * NEVER use Devanagari Hindi script (हिंदी) unless the user's input was written in Devanagari script. If user writes in Latin letters, your reply MUST be in Latin letters!
     * If the user writes in ENGLISH, reply in natural, helpful ENGLISH.
     * If the user writes in HINDI (Devanagari script), reply in natural, helpful HINDI.
   - Response formatting examples:
     * When document is MATCHED:
       - Hinglish: "Yeh raha [Person Name] ka [Document Type] jo aapne manga tha."
       - English: "Here is the [Document Type] for [Person Name] you requested."
       - Hindi: "[Person Name] का [Document Type] यह रहा।"
     * When document is NOT FOUND, but OTHER documents exist for that person:
       - Hinglish: "[Person Name] ka [Requested Doc Type] vault me nahi mila. Lekin unka [Available Doc Type] available hai. Kya aapko woh chahiye?"
       - English: "[Requested Doc Type] for [Person Name] was not found in our records. However, we have their [Available Doc Type] on file. Would you like me to share that instead?"
     * When NO documents exist at all for that query/person:
       - Hinglish: "[Person Name] ke naam par koi document nahi mila. Name check kar lijiye ya fir yahan file bhej kar save kar sakte hain."
       - English: "No documents found for [Person Name]. Please check the spelling or send the file here to upload it."
     * When listing documents:
       - Hinglish: "Vault me yeh documents available hain:\n• ..."
       - English: "Here are the available documents in the vault:\n• ..."

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

                reply_text = strip_greetings(result.get("professional_reply") or "I could not find the requested document.")
                return {
                    "intent": result.get("intent", "document_request"),
                    "matched_doc_id": matched_id if matched_doc else None,
                    "matched_doc": matched_doc,
                    "requested_person": result.get("requested_person"),
                    "requested_doc_type": result.get("requested_doc_type"),
                    "professional_reply": reply_text or "Requested document was not found in records.",
                }
        except Exception as model_err:
            print(f"[analyzer.conversational_document_retrieval] Model '{current_model}' failed: {model_err}. Trying fallback...")
            continue

    default_res["professional_reply"] = strip_greetings(default_res["professional_reply"])
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
