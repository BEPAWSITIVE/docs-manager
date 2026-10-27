"""
Database Module for Docs Manager.
Connects directly to Supabase Cloud PostgreSQL for structured metadata
and Supabase Storage Bucket for binary document files.
No local disk storage or offline fallbacks.
"""
from datetime import datetime, timezone
import re
import uuid
from typing import Any, Dict, List, Optional
from backend import supabase_client


def save_document(
    doc_id: str,
    original_filename: str,
    saved_filename: str,
    mime_type: str,
    file_size_bytes: int,
    analysis: Dict[str, Any],
    storage_path: str,
    storage_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Saves structured document metadata directly to Supabase PostgreSQL table.
    """
    record = {
        "doc_id": doc_id,
        "original_filename": original_filename,
        "saved_filename": saved_filename,
        "storage_path": storage_path,
        "storage_url": storage_url or "",
        "mime_type": mime_type,
        "file_size_bytes": file_size_bytes,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "analysis": {
            "document_type": analysis.get("document_type", "Document"),
            "person_name": analysis.get("person_name", ""),
            "document_number": analysis.get("document_number", ""),
            "issuing_authority": analysis.get("issuing_authority", ""),
            "dob": analysis.get("dob", ""),
            "searchable_keywords": analysis.get("searchable_keywords", []),
            "short_summary": analysis.get("short_summary", ""),
        },
    }

    # Save directly to Supabase Cloud DB
    supabase_client.save_metadata_to_supabase_db(record)
    return record


def get_document(doc_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single document metadata record from Supabase Cloud DB."""
    return supabase_client.get_metadata_by_id_from_supabase_db(doc_id)


def list_documents() -> List[Dict[str, Any]]:
    """Lists all stored documents directly from Supabase Cloud DB."""
    return supabase_client.get_all_metadata_from_supabase_db()


def delete_document(doc_id: str) -> bool:
    """Deletes a document from Supabase storage bucket and metadata table."""
    doc = get_document(doc_id)
    if not doc:
        return False

    storage_path = doc.get("storage_path") or f"uploads/{doc.get('saved_filename')}"
    if storage_path:
        supabase_client.delete_from_supabase_bucket(storage_path)

    return supabase_client.delete_metadata_from_supabase_db(doc_id)


# =============================================================================
# Client Onboarding & Owner Authorization Functions
# =============================================================================

def normalize_phone(phone: Optional[str]) -> str:
    """
    Normalizes a phone number to digits only.
    Strips domain identifiers (e.g. '@s.whatsapp.net', '@c.us'), '+', spaces, and dashes.
    """
    if not phone:
        return ""
    clean = str(phone).split("@")[0].strip()
    return re.sub(r"\D", "", clean)


def list_clients() -> List[Dict[str, Any]]:
    """Retrieves all onboarded clients."""
    return supabase_client.get_all_clients_from_db()


def save_client(
    name: str,
    phone_number: str,
    notes: str = "",
    is_active: bool = True,
    allow_random_uploads: bool = False,
    client_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Onboards or updates a client with an authorized owner phone number
    and document upload policy.
    """
    cid = client_id or f"client_{uuid.uuid4().hex[:10]}"
    norm_phone = normalize_phone(phone_number)
    now_iso = datetime.now(timezone.utc).isoformat()

    record = {
        "client_id": cid,
        "name": name.strip(),
        "phone_number": phone_number.strip(),
        "normalized_phone": norm_phone,
        "notes": (notes or "").strip(),
        "is_active": bool(is_active),
        "allow_random_uploads": bool(allow_random_uploads),
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    supabase_client.save_client_to_db(record)
    return record


def update_client(client_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Updates fields on an existing onboarded client."""
    clients = list_clients()
    existing = next((c for c in clients if c.get("client_id") == client_id), None)
    if not existing:
        return None

    updated = dict(existing)
    for field in ["name", "phone_number", "notes", "is_active", "allow_random_uploads"]:
        if field in updates and updates[field] is not None:
            updated[field] = updates[field]

    if "phone_number" in updates and updates["phone_number"]:
        updated["normalized_phone"] = normalize_phone(str(updates["phone_number"]))

    updated["updated_at"] = datetime.now(timezone.utc).isoformat()
    supabase_client.save_client_to_db(updated)
    return updated


def delete_client(client_id: str) -> bool:
    """Deletes an onboarded client by client_id."""
    return supabase_client.delete_client_from_db(client_id)


def get_system_settings() -> Dict[str, Any]:
    """Retrieves system-wide settings like global allow_random_uploads."""
    return supabase_client.get_system_settings()


def save_system_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Saves system-wide settings."""
    return supabase_client.save_system_settings(settings)


def is_upload_allowed(phone: Optional[str]) -> bool:
    """
    Determines if document upload is allowed for the given sender.
    - If sender is an authorized owner -> ALWAYS allowed.
    - If global 'allow_random_uploads' setting is True -> allowed.
    - If any active client has 'allow_random_uploads' set to True -> allowed.
    - Otherwise -> rejected (only owners can upload).
    """
    if is_phone_authorized(phone):
        return True

    # Check global system setting
    sys_settings = get_system_settings()
    if sys_settings.get("allow_random_uploads", False):
        return True

    # Check per-client customization toggle
    clients = list_clients()
    for client in clients:
        if client.get("is_active", True) and client.get("allow_random_uploads", False):
            return True

    return False



def is_phone_authorized(phone: Optional[str]) -> bool:
    """
    Validates if the provided phone number matches an active onboarded owner.
    Supports both international prefixes (+91, 91, 1, etc.) and 10-digit matching.
    """
    norm_input = normalize_phone(phone)
    if not norm_input or len(norm_input) < 7:
        return False

    input_last10 = norm_input[-10:] if len(norm_input) >= 10 else norm_input

    clients = list_clients()
    for client in clients:
        if not client.get("is_active", True):
            continue

        c_phone = client.get("phone_number") or ""
        c_norm = client.get("normalized_phone") or normalize_phone(c_phone)

        # 1. Exact numeric match
        if norm_input == c_norm:
            return True

        # 2. Match on trailing 10 digits
        if len(norm_input) >= 10 and len(c_norm) >= 10:
            c_last10 = c_norm[-10:]
            if input_last10 == c_last10:
                return True

    return False

