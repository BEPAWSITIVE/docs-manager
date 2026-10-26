import os
import uuid
import mimetypes
from typing import Any, Dict, Optional
import httpx

from backend import config, database, analyzer, supabase_client

ZERNIO_API_BASE = "https://api.zernio.com/v1"
_processed_events = set()


def get_zernio_api_key() -> str:
    """Reads Zernio API key from config or environment."""
    return config.get_zernio_api_key()


def send_conversation_reply(
    conversation_id: str,
    account_id: str,
    text: str,
    attachment_url: Optional[str] = None,
) -> bool:
    """
    Sends a message reply back to a user via Zernio Unified Inbox API.
    Works for both WhatsApp and SMS conversations.
    """
    api_key = get_zernio_api_key()
    if not api_key:
        print("[Zernio] Warning: ZERNIO_API_KEY is not configured.")
        return False

    url = f"{ZERNIO_API_BASE}/inbox/conversations/{conversation_id}/messages"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload: Dict[str, Any] = {
        "accountId": account_id,
        "message": text,
    }

    if attachment_url:
        payload["attachment"] = {
            "url": attachment_url,
        }

    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            if resp.status_code in [200, 201, 202]:
                print(f"[Zernio] Message sent to conversation {conversation_id}")
                return True
            else:
                print(f"[Zernio] Failed to send message: {resp.status_code} {resp.text}")
                return False
    except Exception as e:
        print(f"[Zernio] Error sending message: {e}")
        return False


def process_incoming_zernio_event(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Processes a webhook event from Zernio.
    Handles:
    1. Incoming documents/images -> Analyzes with Gemini Multimodal OCR -> Stores in Supabase -> Replies '👍'.
    2. Incoming text queries -> Matches document via Gemini AI -> Replies with document details and Supabase link.
    """
    event_id = event_data.get("id")
    event_type = event_data.get("event")

    # Deduplicate repeated webhook deliveries
    if event_id:
        if event_id in _processed_events:
            return {"status": "skipped", "reason": "already_processed"}
        _processed_events.add(event_id)
        # Keep set small
        if len(_processed_events) > 1000:
            _processed_events.clear()

    if event_type != "message.received":
        return {"status": "ignored", "reason": f"unhandled_event: {event_type}"}

    message_data = event_data.get("message", {})
    direction = message_data.get("direction", "inbound")
    if direction != "inbound":
        return {"status": "ignored", "reason": "outbound_message"}

    conversation = event_data.get("conversation", {})
    conversation_id = conversation.get("conversationId")
    account_id = event_data.get("account", {}).get("accountId")

    if not conversation_id or not account_id:
        return {"status": "ignored", "reason": "missing_conversation_or_account"}

    attachments = message_data.get("attachments", [])
    text_content = (message_data.get("text") or "").strip()

    # =========================================================================
    # Case 1: User uploaded one or more document / image attachments
    # =========================================================================
    if attachments:
        processed_count = 0
        last_doc_name = ""

        for att in attachments:
            media_url = att.get("url")
            if not media_url:
                continue

            try:
                # 1. Download media bytes from Zernio URL
                with httpx.Client(timeout=10.0) as http_client:
                    media_resp = http_client.get(media_url)
                    if media_resp.status_code != 200:
                        continue
                    file_bytes = media_resp.content

                mime_type = att.get("type") or media_resp.headers.get("content-type") or "image/jpeg"
                file_ext = mimetypes.guess_extension(mime_type) or ".jpg"
                doc_id = uuid.uuid4().hex[:12]
                saved_filename = f"{doc_id}{file_ext}"
                filename = att.get("filename") or f"whatsapp_{saved_filename}"

                # 2. AI Multimodal OCR analysis directly from in-memory bytes
                analysis = analyzer.analyze_document(
                    file_bytes=file_bytes,
                    mime_type=mime_type,
                    filename=filename,
                    api_key=config.get_api_key(),
                )

                # 3. Upload to Supabase Storage Bucket
                sb_info = supabase_client.upload_to_supabase_bucket(
                    file_bytes=file_bytes,
                    saved_filename=saved_filename,
                    mime_type=mime_type,
                )

                # 4. Save structured metadata to Supabase DB
                database.save_document(
                    doc_id=doc_id,
                    original_filename=filename,
                    saved_filename=saved_filename,
                    mime_type=mime_type,
                    file_size_bytes=len(file_bytes),
                    analysis=analysis,
                    storage_path=sb_info["storage_path"],
                    storage_url=sb_info.get("storage_url"),
                )

                processed_count += 1
                doc_type = analysis.get("document_type") or "Document"
                person = analysis.get("person_name") or ""
                last_doc_name = f"{doc_type} ({person})" if person else doc_type

            except Exception as ex:
                print(f"[Zernio] Attachment processing error: {ex}")

        if processed_count > 0:
            # Strict user specification: thumbs up response
            reply_text = "👍"
            send_conversation_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                text=reply_text,
            )
            return {"status": "uploaded", "count": processed_count}
        else:
            send_conversation_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                text="⚠️ Could not process the uploaded file. Please send a clear image or PDF.",
            )
            return {"status": "failed", "reason": "attachment_download_or_ocr_failed"}

    # =========================================================================
    # Case 2: User sent a natural language query asking for a document
    # =========================================================================
    if text_content:
        docs = database.list_documents()
        if not docs:
            send_conversation_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                text="No documents have been stored in the vault yet. Upload an ID or document first!",
            )
            return {"status": "no_docs_in_vault"}

        # Strict AI retrieval using Gemini
        matched_doc = analyzer.find_matching_document(
            query=text_content,
            documents=docs,
            api_key=config.get_api_key(),
        )

        if matched_doc:
            doc_id = matched_doc.get("doc_id")
            analysis = matched_doc.get("analysis", {})
            doc_type = analysis.get("document_type", "Document")
            person_name = analysis.get("person_name", "")
            doc_num = analysis.get("document_number", "")
            summary = analysis.get("short_summary", "")
            file_url = matched_doc.get("storage_url") or ""

            # Build a neat WhatsApp response
            lines = [f"📄 *{doc_type}*"]
            if person_name:
                lines.append(f"👤 Name: {person_name}")
            if doc_num:
                lines.append(f"🔢 ID Number: {doc_num}")
            if summary:
                lines.append(f"ℹ️ {summary}")
            if file_url:
                lines.append(f"\n🔗 View / Download:\n{file_url}")

            reply_msg = "\n".join(lines)
            send_conversation_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                text=reply_msg,
                attachment_url=file_url if file_url else None,
            )
            return {"status": "matched", "doc_id": doc_id}
        else:
            send_conversation_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                text="Document not found. Please specify the person's name or document type (e.g. 'Give me Shivam's Aadhar card').",
            )
            return {"status": "not_found"}

    return {"status": "noop"}
