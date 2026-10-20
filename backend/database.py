"""
Database Module for Docs Manager.
Connects directly to Supabase Cloud PostgreSQL for structured metadata
and Supabase Storage Bucket for binary document files.
No local disk storage or offline fallbacks.
"""
from datetime import datetime, timezone
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
