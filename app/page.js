'use client';

import React, { useState, useEffect, useRef } from 'react';

export default function DocsManagerPage() {
  // State
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-3.5-flash-lite');
  const [hasBackendKey, setHasBackendKey] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [storedDocs, setStoredDocs] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mobileView, setMobileView] = useState('chat'); // 'chat' | 'sidebar'

  // Supabase Server Status State
  const [supabaseBucket, setSupabaseBucket] = useState('documents');
  const [isSupabaseEnabled, setIsSupabaseEnabled] = useState(false);
  const [settingsTab, setSettingsTab] = useState('status'); // 'status' | 'sql'
  const [copiedSql, setCopiedSql] = useState(false);

  // Admin Panel & Client Onboarding State
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientForm, setClientForm] = useState({
    name: '',
    phone_number: '',
    notes: '',
    is_active: true,
  });
  const [clientFormSubmitting, setClientFormSubmitting] = useState(false);
  const [clientFormError, setClientFormError] = useState('');
  const [clientFormSuccess, setClientFormSuccess] = useState('');

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Load Server Status & Model Preference
  useEffect(() => {
    const initConfig = async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.has_key) {
            setHasBackendKey(true);
          }
        }
      } catch (err) {
        console.log('Error checking backend config:', err);
      }

      // Check Supabase Cloud status
      try {
        const sbRes = await fetch('/api/supabase/config');
        if (sbRes.ok) {
          const sbCfg = await sbRes.json();
          if (sbCfg.bucket) setSupabaseBucket(sbCfg.bucket);
          if (sbCfg.enabled) setIsSupabaseEnabled(true);
        }
      } catch (err) {
        console.log('Error checking supabase config:', err);
      }

      const savedModel = localStorage.getItem('gemini_model');
      if (savedModel && ['gemini-3.5-flash-lite', 'gemini-3.5-flash'].includes(savedModel)) {
        setSelectedModel(savedModel);
      } else {
        setSelectedModel('gemini-3.5-flash-lite');
        localStorage.setItem('gemini_model', 'gemini-3.5-flash-lite');
      }

      fetchStoredDocuments();
      fetchClients();
    };

    initConfig();
  }, []);

  const fetchClients = async () => {
    try {
      setLoadingClients(true);
      const res = await fetch('/api/clients');
      if (res.ok) {
        const data = await res.json();
        setClients(data.clients || []);
      }
    } catch (err) {
      console.log('Error fetching clients:', err);
    } finally {
      setLoadingClients(false);
    }
  };

  const handleOnboardClient = async (e) => {
    e.preventDefault();
    setClientFormError('');
    setClientFormSuccess('');

    if (!clientForm.name.trim()) {
      setClientFormError('Please enter a client / owner name.');
      return;
    }
    if (!clientForm.phone_number.trim()) {
      setClientFormError('Please enter the owner WhatsApp phone number.');
      return;
    }

    try {
      setClientFormSubmitting(true);
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clientForm),
      });

      if (res.ok) {
        setClientFormSuccess(`Owner "${clientForm.name}" onboarded successfully!`);
        setClientForm({ name: '', phone_number: '', notes: '', is_active: true });
        fetchClients();
      } else {
        const err = await res.json();
        setClientFormError(err.detail || 'Failed to onboard client.');
      }
    } catch (err) {
      setClientFormError('Network error while onboarding client.');
    } finally {
      setClientFormSubmitting(false);
    }
  };

  const handleToggleClientStatus = async (clientId, currentStatus) => {
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !currentStatus }),
      });
      if (res.ok) {
        fetchClients();
      }
    } catch (err) {
      console.log('Error updating client status:', err);
    }
  };

  const handleDeleteClient = async (clientId, clientName) => {
    if (!confirm(`Are you sure you want to remove owner access for "${clientName}"?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        fetchClients();
      }
    } catch (err) {
      console.log('Error deleting client:', err);
    }
  };

  const fetchStoredDocuments = async () => {
    try {
      const res = await fetch('/api/documents');
      if (res.ok) {
        const data = await res.json();
        setStoredDocs(data.documents || []);
      }
    } catch (e) {
      console.log('Backend not reached yet:', e);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleModelChange = (model) => {
    setSelectedModel(model);
    localStorage.setItem('gemini_model', model);
  };

  const copySqlSnippet = () => {
    const sql = `-- 1. Create Documents Metadata Table
CREATE TABLE IF NOT EXISTS documents_metadata (
    doc_id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    saved_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    storage_url TEXT,
    mime_type TEXT,
    file_size_bytes BIGINT,
    document_type TEXT,
    person_name TEXT,
    document_number TEXT,
    issuing_authority TEXT,
    dob TEXT,
    searchable_keywords TEXT[],
    short_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow all reads/writes on metadata table
ALTER TABLE documents_metadata ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on documents_metadata" ON documents_metadata;
CREATE POLICY "Allow all on documents_metadata"
ON documents_metadata FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- 2. Create Storage Bucket 'documents' (public)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', true, null, null)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 3. Storage Object Policies (Idempotent: drop first if exists)
DROP POLICY IF EXISTS "Allow public storage upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow public storage select" ON storage.objects;
DROP POLICY IF EXISTS "Allow public storage update" ON storage.objects;
DROP POLICY IF EXISTS "Allow public storage delete" ON storage.objects;

CREATE POLICY "Allow public storage upload"
ON storage.objects FOR INSERT
TO public
WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow public storage select"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'documents');

CREATE POLICY "Allow public storage update"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'documents')
WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow public storage delete"
ON storage.objects FOR DELETE
TO public
USING (bucket_id = 'documents');

-- 4. Create Authorized Clients Table (Owner Access Control)
CREATE TABLE IF NOT EXISTS authorized_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE authorized_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on authorized_clients" ON authorized_clients;
CREATE POLICY "Allow all on authorized_clients"
ON authorized_clients FOR ALL
TO public
USING (true)
WITH CHECK (true);`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(sql);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2000);
    }
  };

  const getFormatTime = () => {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  // Helper: Format file size
  const formatFileSize = (bytes) => {
    if (!bytes) return '1.0 MB';
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Helper: Get styled badge for any file format
  const getFileBadge = (filename = '') => {
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (ext === 'pdf') {
      return { label: 'PDF', className: 'pdf-badge' };
    }
    if (['doc', 'docx', 'odt'].includes(ext)) {
      return { label: 'DOC', className: 'pdf-badge badge-doc' };
    }
    if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) {
      return { label: 'XLS', className: 'pdf-badge badge-xls' };
    }
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'tiff'].includes(ext)) {
      return { label: 'IMG', className: 'pdf-badge badge-img' };
    }
    if (['txt', 'md', 'log', 'rtf'].includes(ext)) {
      return { label: 'TXT', className: 'pdf-badge badge-txt' };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return { label: 'ZIP', className: 'pdf-badge badge-zip' };
    }
    if (['py', 'js', 'ts', 'html', 'css', 'json', 'cpp', 'java'].includes(ext)) {
      return { label: 'CODE', className: 'pdf-badge badge-code' };
    }
    return {
      label: ext.slice(0, 4).toUpperCase() || 'FILE',
      className: 'pdf-badge badge-file',
    };
  };

  const isImageFile = (filename = '', mimeType = '') => {
    if (mimeType && mimeType.startsWith('image/')) return true;
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'].includes(ext);
  };

  // Generic File Upload Function
  const uploadFile = async (file) => {
    if (!file) return;

    // Vercel Serverless Functions have a strict 4.5 MB request payload limit
    if (file.size > 4.5 * 1024 * 1024) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: 'user',
          type: 'upload',
          filename: file.name,
          size: `${formatFileSize(file.size)} • ${file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : 'FILE'}`,
          time: getFormatTime(),
        },
        {
          id: Date.now() + 1,
          role: 'assistant',
          type: 'text',
          content: `⚠️ Upload failed: File size (${sizeMB} MB) exceeds Vercel's 4.5 MB serverless limit. Please compress or upload files under 4.5 MB.`,
          time: getFormatTime(),
        },
      ]);
      return;
    }

    const timeNow = getFormatTime();
    const extUpper = file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : 'FILE';
    const sizeStr = `${formatFileSize(file.size)} • ${extUpper}`;

    // 1. Add user outgoing upload bubble
    const userMsgId = Date.now();
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: 'user',
        type: 'upload',
        filename: file.name,
        size: sizeStr,
        time: timeNow,
      },
    ]);

    // 2. Send to FastAPI backend
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (selectedModel) formData.append('model', selectedModel);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        // Strict response: thumbs up (👍)
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            type: 'thumbs_up',
            content: '👍',
            time: getFormatTime(),
          },
        ]);
        fetchStoredDocuments();
      } else {
        const errData = await res.json().catch(() => ({}));
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            type: 'text',
            content: errData.detail || 'Upload failed. Please check server environment configuration.',
            time: getFormatTime(),
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          type: 'text',
          content: 'Server connection failed.',
          time: getFormatTime(),
        },
      ]);
    }
  };

  // Clipboard Paste Handler (Ctrl + V)
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          uploadFile(file);
          e.preventDefault();
          return;
        }
      }
    }
  };

  // File picker change handler
  const handleFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = '';
  };

  // Drag and Drop handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      uploadFile(files[0]);
    }
  };

  // Query handler
  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (!input.trim()) return;

    const queryText = input.trim();
    const timeNow = getFormatTime();
    setInput('');

    // Add user question
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        role: 'user',
        type: 'text',
        content: queryText,
        time: timeNow,
      },
    ]);

    // Send query to FastAPI
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryText,
          model: selectedModel,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.found && data.document) {
          // Deliver matched document directly without chatter
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now() + 1,
              role: 'assistant',
              type: 'document',
              doc: data.document,
              time: getFormatTime(),
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now() + 1,
              role: 'assistant',
              type: 'text',
              content: data.message || 'Document not found.',
              time: getFormatTime(),
            },
          ]);
        }
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            type: 'text',
            content: 'Document not found.',
            time: getFormatTime(),
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          type: 'text',
          content: 'Backend offline.',
          time: getFormatTime(),
        },
      ]);
    }
  };

  const deleteDocument = async (docId) => {
    try {
      await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
      fetchStoredDocuments();
    } catch (e) {
      console.log('Delete error:', e);
    }
  };

  // Robot Avatar SVG
  const RobotAvatar = () => (
    <svg viewBox="0 0 100 100" width="100%" height="100%">
      <circle cx="50" cy="50" r="50" fill="#075e54" />
      <circle cx="50" cy="20" r="4.5" fill="#ffffff" />
      <line x1="50" y1="24.5" x2="50" y2="34" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      <rect x="24" y="34" width="52" height="42" rx="14" fill="#ffffff" />
      <rect x="18" y="48" width="6" height="14" rx="3" fill="#ffffff" />
      <rect x="76" y="48" width="6" height="14" rx="3" fill="#ffffff" />
      <rect x="31" y="41" width="38" height="28" rx="8" fill="#075e54" />
      <circle cx="43" cy="53" r="4.5" fill="#ffffff" />
      <circle cx="57" cy="53" r="4.5" fill="#ffffff" />
      <path d="M44 62 Q50 66 56 62" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );

  return (
    <div
      className="browser-window"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 3-Panel Main Layout */}
      <div className={`app-container ${mobileView === 'sidebar' ? 'mobile-show-sidebar' : 'mobile-show-chat'}`}>
        {/* 1. Far-Left Navigation Rail (#004838) */}
        <div className="nav-rail">
          <div className="rail-top">
            <button className="rail-btn active" title="Chats" onClick={() => setMobileView('sidebar')}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 1.821.487 3.53 1.338 5L2 22l5.197-1.309A9.957 9.957 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" />
              </svg>
            </button>
            <button
              className={`rail-btn ${isAdminOpen ? 'active' : ''}`}
              title="Admin Panel: Client Onboarding & Owner Access"
              onClick={() => {
                setIsAdminOpen(true);
                fetchClients();
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
            </button>
          </div>
          <div className="rail-bottom">
            <button className="rail-btn" title="Settings & API Key" onClick={() => setIsSettingsOpen(true)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        {/* 2. Left Sidebar (White #ffffff) */}
        <div className="sidebar-panel">
          <div className="sidebar-header">
            <div className="sidebar-brand-wrapper">
              <div className="app-brand-logo">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" />
                </svg>
              </div>
              <div className="app-brand-title">Docs Manager</div>
              {isSupabaseEnabled && (
                <span className="cloud-status-pill" title="Supabase Storage & Metadata Connected">
                  ☁️ Cloud
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="top-action-btn mobile-sidebar-settings-btn"
                title="Client Onboarding"
                onClick={() => {
                  setIsAdminOpen(true);
                  fetchClients();
                }}
                aria-label="Client Onboarding"
              >
                <span style={{ fontSize: 16 }}>👑</span>
              </button>
              <button
                className="top-action-btn mobile-sidebar-settings-btn"
                title="Settings"
                onClick={() => setIsSettingsOpen(true)}
                aria-label="Settings"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>


          <div className="chat-list">
            <div className="chat-item active" onClick={() => setMobileView('chat')}>
              <div className="chat-avatar-round">
                <RobotAvatar />
              </div>
              <div className="chat-item-body">
                <div className="chat-item-row1">
                  <span className="chat-item-name">Docs Manager</span>
                  <span className="chat-item-timestamp">
                    {messages.length > 0 ? messages[messages.length - 1].time : ''}
                  </span>
                </div>
                <div className="chat-item-snippet">
                  {messages.length > 0
                    ? (messages[messages.length - 1].content || messages[messages.length - 1].filename || '👍')
                    : 'Ready to store and retrieve documents'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Main Chat Panel (WhatsApp Doodle Background) */}
        <div className="chat-window">
          {/* Drag & Drop Feedback Overlay */}
          {isDragging && (
            <div className="dropzone-overlay">
              <div className="dropzone-pill">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#008069" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
                <span>Drop any document or file to upload</span>
              </div>
            </div>
          )}

          {/* Top Bar */}
          <div className="chat-top-bar">
            <div className="chat-top-left">
              <button
                type="button"
                className="mobile-back-btn"
                title="Back to chats"
                onClick={() => setMobileView('sidebar')}
                aria-label="Back to chats"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"></line>
                  <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
              </button>
              <div className="top-avatar" onClick={() => setMobileView('sidebar')} style={{ cursor: 'pointer' }}>
                <RobotAvatar />
              </div>
              <div onClick={() => setMobileView('sidebar')} style={{ cursor: 'pointer' }}>
                <div className="top-name">Docs Manager</div>
                <div className="top-status">
                  Online {isSupabaseEnabled ? '• ☁️ Supabase Cloud' : ''}
                </div>
              </div>
            </div>
            <div className="chat-top-actions">
              <button
                type="button"
                className="admin-badge-btn"
                title="Client Onboarding & Owner Numbers"
                onClick={() => {
                  setIsAdminOpen(true);
                  fetchClients();
                }}
              >
                <span className="admin-badge-icon">👑</span>
                <span className="admin-badge-text">Onboard Clients</span>
              </button>
              <button
                type="button"
                className="top-action-btn"
                title="Settings"
                onClick={() => setIsSettingsOpen(true)}
                aria-label="Settings"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Messages Canvas */}
          <div className="messages-container">
            {messages.length === 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '24px' }}>
                <div
                  style={{
                    backgroundColor: '#ffeecd',
                    color: '#54656f',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    fontSize: '12.5px',
                    boxShadow: '0 1px 2px rgba(11,20,26,0.1)',
                    maxWidth: '480px',
                    textAlign: 'center',
                    lineHeight: '1.4',
                  }}
                >
                  🔒 Messages and documents are processed with AI. Paste (Ctrl+V) or attach any ID or document to classify and save.
                </div>
              </div>
            )}
            {messages.map((msg) => {
              if (msg.role === 'user') {
                const badge = getFileBadge(msg.filename);
                return (
                  <div key={msg.id} className="msg-row out">
                    <div className="bubble out">
                      {msg.type === 'upload' ? (
                        <div className="document-card">
                          <div className="doc-left">
                            <div className={badge.className}>{badge.label}</div>
                            <div className="doc-info">
                              <span className="doc-name">{msg.filename}</span>
                              <span className="doc-meta">{msg.size}</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <span>{msg.content}</span>
                      )}
                      <div className="bubble-footer">
                        <span>{msg.time}</span>
                        <span className="check-ticks">✓✓</span>
                      </div>
                    </div>
                  </div>
                );
              } else {
                const isImg = isImageFile(msg.doc?.original_filename || '', msg.doc?.mime_type || '');
                const docBadge = getFileBadge(msg.doc?.original_filename || 'document.pdf');
                const analysis = msg.doc?.analysis || {};
                const docType = analysis.document_type || 'Document';
                const personName = analysis.person_name || '';
                const docNumber = analysis.document_number || '';

                return (
                  <div key={msg.id} className="msg-row in">
                    <div className="msg-avatar">
                      <RobotAvatar />
                    </div>
                    <div className={`bubble in ${msg.type === 'thumbs_up' ? 'thumbs' : ''}`}>
                      {msg.type === 'thumbs_up' ? (
                        <span className="emoji-large">👍</span>
                      ) : msg.type === 'document' ? (
                        <div>
                          {/* If image, display actual image preview */}
                          {isImg && msg.doc?.doc_id && (
                            <div className="doc-image-wrapper">
                              <img
                                src={`/api/documents/${msg.doc.doc_id}/file`}
                                alt={docType}
                                onClick={() => window.open(`/api/documents/${msg.doc.doc_id}/file`, '_blank')}
                                title="Click to view full size"
                              />
                            </div>
                          )}

                          {/* Metadata badges row */}
                          <div className="doc-meta-badges">
                            <span className="doc-badge-pill doc-badge-green">📄 {docType}</span>
                            {personName && <span className="doc-badge-pill">👤 {personName}</span>}
                            {docNumber && <span className="doc-badge-pill">🆔 {docNumber}</span>}
                          </div>

                          <div className="document-card">
                            <div className="doc-left">
                              <div className={docBadge.className}>{docBadge.label}</div>
                              <div className="doc-info">
                                <span className="doc-name">{msg.doc?.original_filename || 'document'}</span>
                                <span className="doc-meta">
                                  {formatFileSize(msg.doc?.file_size_bytes)} • {msg.doc?.original_filename?.split('.').pop()?.toUpperCase() || 'FILE'}
                                </span>
                              </div>
                            </div>
                            <a
                              href={`/api/documents/${msg.doc?.doc_id}/file?download=true`}
                              download={msg.doc?.original_filename || 'document'}
                              className="download-circle-btn"
                              title="Download Document"
                            >
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </a>
                          </div>
                        </div>
                      ) : (
                        <span>{msg.content}</span>
                      )}
                      <div className="bubble-footer">
                        <span>{msg.time}</span>
                      </div>
                    </div>
                  </div>
                );
              }
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Bottom Chat Input Bar - ACCEPTS ALL FILE UPLOADS VIA BUTTON, DRAG & DROP, OR CLIPBOARD PASTE */}
          <form className="chat-input-bar" onSubmit={handleSendMessage}>
            {/* Hidden Input for ANY file type */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="action-icon-btn"
              title="Attach Any File or Document"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <button
              type="button"
              className="action-icon-btn"
              title="Upload File"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </button>
            <div className="input-pill-wrapper">
              <input
                type="text"
                className="chat-input-text"
                placeholder="Type a message, paste image/file (Ctrl+V), or drag & drop..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handlePaste}
              />
            </div>
            <button type="submit" className="send-circle-btn" title="Send">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" fill="white" />
              </svg>
            </button>
          </form>
        </div>
      </div>

      {/* Settings Modal (System Status & SQL Setup) */}
      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              <span>⚙️</span> Docs Manager Settings
            </div>
            <div className="modal-desc">
              System status, AI classification engine, and database schema setup.
            </div>

            {/* Modal Tabs */}
            <div className="modal-tabs">
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'status' ? 'active' : ''}`}
                onClick={() => setSettingsTab('status')}
              >
                <span>📊</span> System Status
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'sql' ? 'active' : ''}`}
                onClick={() => setSettingsTab('sql')}
              >
                <span>☁️</span> Supabase SQL Setup
              </button>
            </div>

            {settingsTab === 'status' ? (
              <div>
                {/* Gemini AI Status Card */}
                <div className="settings-service-card">
                  <div className="service-card-header">
                    <div className="service-name-row">
                      <span className="service-icon">🤖</span>
                      <div>
                        <strong>Gemini AI Engine</strong>
                        <div className="service-subtext">Vision, OCR & Semantic Document Retrieval</div>
                      </div>
                    </div>
                    {hasBackendKey ? (
                      <span className="status-badge connected">● Connected</span>
                    ) : (
                      <span className="status-badge missing">⚠️ Missing GEMINI_API_KEY</span>
                    )}
                  </div>

                  <div className="form-group" style={{ marginTop: 14, marginBottom: 4 }}>
                    <label className="form-label">Active Gemini Model</label>
                    <select
                      className="form-input"
                      value={selectedModel}
                      onChange={(e) => handleModelChange(e.target.value)}
                    >
                      <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite (Ultra Fast & Recommended)</option>
                      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                    </select>
                  </div>
                </div>

                {/* Supabase Cloud Status Card */}
                <div className="settings-service-card" style={{ marginTop: 12 }}>
                  <div className="service-card-header">
                    <div className="service-name-row">
                      <span className="service-icon">☁️</span>
                      <div>
                        <strong>Supabase Cloud Storage & DB</strong>
                        <div className="service-subtext">Bucket: <code>{supabaseBucket}</code></div>
                      </div>
                    </div>
                    {isSupabaseEnabled ? (
                      <span className="status-badge connected">● Connected</span>
                    ) : (
                      <span className="status-badge missing">⚠️ Missing SUPABASE_URL / KEY</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#667781', marginTop: 8 }}>
                    {isSupabaseEnabled
                      ? 'Binary files are stored in Supabase Storage and metadata is indexed in Supabase DB.'
                      : 'Cloud database required. Please set SUPABASE_URL and SUPABASE_KEY in Vercel environment variables.'}
                  </div>
                </div>

                {/* Zernio WhatsApp & SMS Card */}
                <div className="settings-service-card" style={{ marginTop: 12 }}>
                  <div className="service-card-header">
                    <div className="service-name-row">
                      <span className="service-icon">📱</span>
                      <div>
                        <strong>Zernio WhatsApp & SMS Gateway</strong>
                        <div className="service-subtext">Mobile Number Webhook Integration</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#667781', marginTop: 8 }}>
                    Upload and search documents directly via your Zernio US number over WhatsApp or SMS.
                  </div>
                  <div style={{ marginTop: 8, background: '#f0f2f5', padding: '8px 10px', borderRadius: 6, fontSize: 12, wordBreak: 'break-all' }}>
                    <strong>Webhook URL:</strong> <code>{typeof window !== 'undefined' ? `${window.location.origin}/api/zernio/webhook` : '/api/zernio/webhook'}</code>
                  </div>
                </div>

                {/* Security Notice Box */}
                <div className="security-notice-box" style={{ marginTop: 16 }}>
                  <div className="security-notice-title">
                    <span>🔒</span> Security & Environment Variables
                  </div>
                  <p className="security-notice-p">
                    For optimal security, credentials cannot be entered in the browser. Configure them securely in your server environment (<code>.env</code> file locally or <strong>Vercel Environment Variables</strong>):
                  </p>
                  <div className="security-env-grid">
                    <div className="env-grid-item">
                      <code>GEMINI_API_KEY</code>
                      <span>Google AI Gemini API key</span>
                    </div>
                    <div className="env-grid-item">
                      <code>SUPABASE_URL</code>
                      <span>Supabase Project URL</span>
                    </div>
                    <div className="env-grid-item">
                      <code>SUPABASE_KEY</code>
                      <span>Supabase <code>service_role</code> secret key</span>
                    </div>
                    <div className="env-grid-item">
                      <code>ZERNIO_API_KEY</code>
                      <span>Zernio API Key (from Zernio Dashboard)</span>
                    </div>
                    <div className="env-grid-item">
                      <code>SUPABASE_BUCKET</code>
                      <span>Optional bucket name (default: <code>documents</code>)</span>
                    </div>
                  </div>
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn-primary" onClick={() => setIsSettingsOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p style={{ fontSize: 13, color: '#667781', marginBottom: 12, lineHeight: 1.5 }}>
                  Run this SQL query in your <strong>Supabase Dashboard → SQL Editor</strong> to automatically create the metadata table and storage bucket access policies:
                </p>

                {/* SQL Table & Storage Policies Creation Guide */}
                <div className="sql-container">
                  <div className="sql-header">
                    <span>Supabase SQL Setup (Table & Storage Policies)</span>
                    <button
                      type="button"
                      className="sql-copy-btn"
                      onClick={copySqlSnippet}
                    >
                      {copiedSql ? '✓ Copied!' : 'Copy SQL'}
                    </button>
                  </div>
                  <pre className="sql-pre">
{`-- 1. Create Documents Metadata Table
CREATE TABLE IF NOT EXISTS documents_metadata (
    doc_id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    saved_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    storage_url TEXT,
    mime_type TEXT,
    file_size_bytes BIGINT,
    document_type TEXT,
    person_name TEXT,
    document_number TEXT,
    issuing_authority TEXT,
    dob TEXT,
    searchable_keywords TEXT[],
    short_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Storage Bucket Policies (enables upload & download if using anon key)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('documents', 'documents', true) 
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Allow public storage upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow public storage select" ON storage.objects
FOR SELECT USING (bucket_id = 'documents');

CREATE POLICY "Allow public storage delete" ON storage.objects
FOR DELETE USING (bucket_id = 'documents');

-- 3. Create Authorized Clients Table (Owner Access Control)
CREATE TABLE IF NOT EXISTS authorized_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);`}
                  </pre>
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn-primary" onClick={() => setIsSettingsOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Client Onboarding & Owner Access Admin Panel Modal */}
      {isAdminOpen && (
        <div className="modal-overlay" onClick={() => setIsAdminOpen(false)}>
          <div className="admin-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="admin-modal-crown">👑</span>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#111b21' }}>
                    Client Onboarding & Owner Access
                  </div>
                  <div style={{ fontSize: 12, color: '#667781', fontWeight: 400 }}>
                    Register authorized owner numbers for WhatsApp document upload and retrieval.
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsAdminOpen(false)}
                aria-label="Close"
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 20,
                  cursor: 'pointer',
                  color: '#667781',
                }}
              >
                ✕
              </button>
            </div>

            {/* Security Policy Banner */}
            <div className="admin-policy-banner" style={{ marginTop: 14 }}>
              <span className="policy-badge">Strict Owner Authorization</span>
              <div className="policy-desc">
                <strong>Authorized Owner Numbers:</strong> Can upload docs and fetch docs via AI WhatsApp chat.<br />
                <strong>Non-Owner / Other Numbers:</strong> Cannot fetch docs. For them, AI will <strong>NOT respond anything</strong> for the fetch request (complete silence).
              </div>
            </div>

            {/* Metrics */}
            <div className="admin-stats-row">
              <div className="admin-stat-card">
                <div className="stat-label">Total Onboarded Clients</div>
                <div className="stat-value">{clients.length}</div>
              </div>
              <div className="admin-stat-card">
                <div className="stat-label">Active Owner Numbers</div>
                <div className="stat-value active-val">
                  {clients.filter((c) => c.is_active).length}
                </div>
              </div>
              <div className="admin-stat-card">
                <div className="stat-label">AI WhatsApp Gateway</div>
                <div className="stat-value text-sm">+1 864-947-4753</div>
              </div>
            </div>

            {/* Client Onboarding Form */}
            <div className="admin-section-box">
              <div className="admin-section-title">
                <span>➕</span> Onboard New Client / Owner
              </div>
              <form onSubmit={handleOnboardClient}>
                <div className="form-grid-3">
                  <div className="form-group mb-0">
                    <label className="form-label">Client Name *</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. Shivam Sharma"
                      value={clientForm.name}
                      onChange={(e) => setClientForm({ ...clientForm, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label">Owner WhatsApp Number *</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. +91 7678106554"
                      value={clientForm.phone_number}
                      onChange={(e) => setClientForm({ ...clientForm, phone_number: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label">Notes / Company (Optional)</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. Verified Owner"
                      value={clientForm.notes}
                      onChange={(e) => setClientForm({ ...clientForm, notes: e.target.value })}
                    />
                  </div>
                </div>

                {clientFormError && <div className="admin-form-msg error">{clientFormError}</div>}
                {clientFormSuccess && <div className="admin-form-msg success">{clientFormSuccess}</div>}

                <div className="form-action-row">
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={clientFormSubmitting}
                  >
                    {clientFormSubmitting ? 'Onboarding...' : 'Onboard Client & Grant Access'}
                  </button>
                </div>
              </form>
            </div>

            {/* Clients List Table */}
            <div className="admin-section-box">
              <div className="admin-section-title-between">
                <div>
                  <span>📋</span> Authorized Owner Phone Numbers ({clients.length})
                </div>
                <button
                  type="button"
                  className="sql-copy-btn"
                  onClick={fetchClients}
                  title="Refresh Clients List"
                >
                  🔄 Refresh
                </button>
              </div>

              {loadingClients ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#667781', fontSize: 13 }}>
                  Loading authorized clients...
                </div>
              ) : clients.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#667781', fontSize: 13 }}>
                  No clients onboarded yet. Add your first client above.
                </div>
              ) : (
                <div className="clients-table-wrapper">
                  <table className="clients-table">
                    <thead>
                      <tr>
                        <th>Client Name</th>
                        <th>WhatsApp Number</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map((c) => (
                        <tr key={c.client_id}>
                          <td className="client-name-cell">
                            <strong>{c.name}</strong>
                          </td>
                          <td>
                            <code className="phone-code">{c.phone_number}</code>
                          </td>
                          <td>
                            <button
                              type="button"
                              className={`status-pill-btn ${c.is_active ? 'active' : 'inactive'}`}
                              onClick={() => handleToggleClientStatus(c.client_id, c.is_active)}
                              title="Click to toggle access"
                            >
                              {c.is_active ? '● Authorized' : '○ Revoked'}
                            </button>
                          </td>
                          <td className="client-notes-cell">{c.notes || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="client-del-btn"
                              onClick={() => handleDeleteClient(c.client_id, c.name)}
                              title="Remove owner access"
                            >
                              🗑️ Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="modal-footer" style={{ marginTop: 12 }}>
              <button type="button" className="btn-primary" onClick={() => setIsAdminOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
