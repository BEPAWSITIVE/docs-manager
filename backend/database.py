import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from backend.config import METADATA_FILE, DOCUMENTS_DIR
from backend import supabase_client

_lock = threading.Lock()


def _read_db() -> Dict[str, Any]:
    """Reads the metadata JSON file safely."""
    with _lock:
        if not METADATA_FILE.exists():
            return {"documents": {}}
        try:
            with open(METADATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if not isinstance(data, dict) or "documents" not in data:
                    return {"documents": {}}
                return data
        except (json.JSONDecodeError, OSError):
            return {"documents": {}}


def _write_db(data: Dict[str, Any]) -> None:
    """Writes the metadata JSON file atomically."""
    with _lock:
        METADATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = METADATA_FILE.with_suffix(".tmp")
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        temp_file.replace(METADATA_FILE)


def save_document(
    doc_id: str,
    original_filename: str,
    saved_filename: str,
    file_path: Path,
    mime_type: str,
    file_size_bytes: int,
    analysis: Dict[str, Any],
    storage_path: Optional[str] = None,
    storage_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Saves document record and metadata to Supabase DB and local database."""
    record = {
        "doc_id": doc_id,
        "original_filename": original_filename,
        "saved_filename": saved_filename,
        "file_path": str(file_path),
        "storage_path": storage_path or f"uploads/{saved_filename}",
        "storage_url": storage_url or "",
        "mime_type": mime_type,
        "file_size_bytes": file_size_bytes,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "analysis": {
            "document_type": analysis.get("document_type", "Unknown Document"),
            "person_name": analysis.get("person_name", ""),
            "document_number": analysis.get("document_number", ""),
            "issuing_authority": analysis.get("issuing_authority", ""),
            "dob": analysis.get("dob", ""),
            "searchable_keywords": analysis.get("searchable_keywords", []),
            "short_summary": analysis.get("short_summary", ""),
        },
    }

    # If Supabase is enabled, save metadata to Supabase PostgreSQL table
    if supabase_client.get_supabase_config().get("enabled"):
        supabase_client.save_metadata_to_supabase_db(record)

    db = _read_db()
    db["documents"][doc_id] = record
    _write_db(db)
    return record


def get_document(doc_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single document by doc_id."""
    db = _read_db()
    doc = db["documents"].get(doc_id)

    # Try Supabase if missing from local db
    if not doc and supabase_client.get_supabase_config().get("enabled"):
        sb_docs = supabase_client.get_all_metadata_from_supabase_db()
        if sb_docs:
            for d in sb_docs:
                if d.get("doc_id") == doc_id:
                    doc = d
                    break

    if doc:
        saved_fn = doc.get("saved_filename")
        if saved_fn and (DOCUMENTS_DIR / saved_fn).exists():
            doc["file_path"] = str(DOCUMENTS_DIR / saved_fn)
        return doc

    return None


def list_documents() -> List[Dict[str, Any]]:
    """Lists all stored documents, newest first from Supabase or local store."""
    if supabase_client.get_supabase_config().get("enabled"):
        sb_docs = supabase_client.get_all_metadata_from_supabase_db()
        if sb_docs is not None and len(sb_docs) > 0:
            # Sync to local cache
            db = _read_db()
            for doc in sb_docs:
                db["documents"][doc["doc_id"]] = doc
            _write_db(db)
            return sb_docs

    db = _read_db()
    docs = list(db["documents"].values())
    docs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return docs


def delete_document(doc_id: str) -> bool:
    """Deletes document file from Supabase Bucket / local disk and removes metadata."""
    db = _read_db()
    doc = db["documents"].get(doc_id)
    if doc:
        # Delete from Supabase if enabled
        if supabase_client.get_supabase_config().get("enabled"):
            spath = doc.get("storage_path") or f"uploads/{doc.get('saved_filename')}"
            supabase_client.delete_from_supabase_bucket(spath)
            supabase_client.delete_metadata_from_supabase_db(doc_id)

        file_path = Path(doc.get("file_path", ""))
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            pass
        del db["documents"][doc_id]
        _write_db(db)
        return True
    return False


STOP_WORDS = {
    "ka", "ki", "ke", "ko", "se", "me", "mein", "par", "pe",
    "dena", "dijiye", "do", "bhejo", "chahiye", "hai", "karo", "dikhao", "batao",
    "the", "a", "an", "is", "of", "in", "to", "for", "with", "and", "or",
    "my", "me", "give", "show", "get", "find", "search", "please", "send",
    "card", "document", "doc", "file"
}

SYNONYMS = {
    "aadhar": "aadhaar",
    "adhar": "aadhaar",
    "aadhaar": "aadhaar",
    "pan": "pan",
    "pancard": "pan",
}


def fallback_keyword_search(query: str) -> Optional[Dict[str, Any]]:
    """
    Deterministic scoring fallback to find best matching document
    if Gemini API matching is unavailable.
    """
    import re

    docs = list_documents()
    if not docs:
        return None

    raw_tokens = [w.lower().strip(".,!?\"'()[]{}") for w in query.split()]
    meaningful_tokens = [
        SYNONYMS.get(w, w)
        for w in raw_tokens
        if len(w) > 1 and w not in STOP_WORDS
    ]

    if not meaningful_tokens:
        return None

    best_score = 0
    best_doc = None

    for doc in docs:
        score = 0
        analysis = doc.get("analysis", {})
        doc_type = analysis.get("document_type", "").lower()
        person_name = analysis.get("person_name", "").lower()
        doc_num = analysis.get("document_number", "").lower()
        keywords = [SYNONYMS.get(k.lower(), k.lower()) for k in analysis.get("searchable_keywords", [])]
        orig_name = doc.get("original_filename", "").lower()

        # Extract words for whole-token exact matching (prevents "ka" matching "kabeer")
        doc_type_words = set(re.findall(r"\w+", doc_type))
        person_words = set(re.findall(r"\w+", person_name))
        orig_name_words = set(re.findall(r"\w+", orig_name))
        all_keyword_words = set()
        for kw in keywords:
            all_keyword_words.update(re.findall(r"\w+", kw))

        has_name_match = False

        for token in meaningful_tokens:
            norm_token = SYNONYMS.get(token, token)

            # 1. Exact match in person name
            if norm_token in person_words:
                score += 15
                has_name_match = True

            # 2. Match in document category / type
            if norm_token in doc_type_words:
                score += 12
            elif any(norm_token in w for w in doc_type_words if len(norm_token) >= 4):
                score += 6

            # 3. Match in keywords
            if norm_token in all_keyword_words:
                score += 8
            elif any(norm_token in kw for kw in keywords if len(norm_token) >= 4):
                score += 4

            # 4. Match in original filename (e.g. adhar and pan.pdf -> matches "aadhaar", "pan")
            if norm_token in orig_name_words:
                score += 10
            elif norm_token in orig_name and len(norm_token) >= 4:
                score += 6

            # 5. Document number
            if norm_token in doc_num and len(norm_token) >= 4:
                score += 12

        # Person name safety guard: If user searched for a specific named person
        # but this document belongs to a DIFFERENT person, penalize heavily so
        # we never return someone else's document (e.g. Kabeer's quotation for Deepak)
        if person_name and not has_name_match:
            for token in meaningful_tokens:
                if (
                    token not in doc_type_words
                    and token not in {"aadhaar", "pan", "passport", "license", "marksheet", "invoice", "quotation", "banner", "poster"}
                ):
                    score -= 15

        if score > best_score:
            best_score = score
            best_doc = doc

    # Meaningful match requires at least 6 points
    if best_score >= 6:
        return best_doc
    return None
