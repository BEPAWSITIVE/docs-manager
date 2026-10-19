'use client';

import React, { useState, useEffect, useRef } from 'react';

export default function DocsManagerPage() {
  // State
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-2.5-flash');
  const [hasBackendKey, setHasBackendKey] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [storedDocs, setStoredDocs] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Supabase Server Status State
  const [supabaseBucket, setSupabaseBucket] = useState('documents');
  const [isSupabaseEnabled, setIsSupabaseEnabled] = useState(false);
  const [settingsTab, setSettingsTab] = useState('status'); // 'status' | 'sql'
  const [copiedSql, setCopiedSql] = useState(false);

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
      if (savedModel) setSelectedModel(savedModel);

      fetchStoredDocuments();
    };

    initConfig();
  }, []);

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

-- 2. Storage Bucket Policies (allows upload & download with anon/publishable key)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('documents', 'documents', true) 
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Allow public storage upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow public storage select" ON storage.objects
FOR SELECT USING (bucket_id = 'documents');

CREATE POLICY "Allow public storage delete" ON storage.objects
FOR DELETE USING (bucket_id = 'documents');`;
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
      {/* Chrome Top Bar */}
      <div className="browser-titlebar">
        <div className="traffic-lights">
          <div className="traffic-light red" />
          <div className="traffic-light yellow" />
          <div className="traffic-light green" />
        </div>
        <div className="browser-tab">
          <div style={{ width: 14, height: 14, backgroundColor: '#00a884', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 9, color: 'white', fontWeight: 'bold' }}>✓</span>
          </div>
          <span>Docs Manager</span>
          <span className="browser-tab-close">×</span>
        </div>
        <span style={{ color: '#5f6368', fontSize: 16 }}>+</span>
      </div>

      {/* Browser URL Navigation Bar */}
      <div className="browser-nav-bar">
        <div className="nav-buttons">
          <span>←</span>
          <span>→</span>
          <span>↻</span>
        </div>
        <div className="url-bar">
          <span style={{ color: '#5f6368', fontSize: 12 }}>🔒</span>
          <span>https://docsmanager.app</span>
        </div>
        <div className="browser-actions">
          <span>☆</span>
          <span>👤</span>
          <span>⋮</span>
        </div>
      </div>

      {/* 3-Panel Main Layout */}
      <div className="app-container">
        {/* 1. Far-Left Navigation Rail (#004838) */}
        <div className="nav-rail">
          <div className="rail-top">
            <button className="rail-btn active" title="Chats">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 1.821.487 3.53 1.338 5L2 22l5.197-1.309A9.957 9.957 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" />
              </svg>
            </button>
            <button className="rail-btn" title="All Channels">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
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

          <div className="sidebar-search-area">
            <div className="search-input-wrapper">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#667781" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="search-input-field"
                placeholder="Search chats..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>


          <div className="chat-list">
            <div className="chat-item active">
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
              <div className="top-avatar">
                <RobotAvatar />
              </div>
              <div>
                <div className="top-name">Docs Manager</div>
                <div className="top-status">
                  Online {isSupabaseEnabled ? '• ☁️ Supabase Cloud Active' : '• Local Vault'}
                </div>
              </div>
            </div>
            <div className="chat-top-actions">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
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
                      <option value="gemini-2.5-flash">gemini-2.5-flash (Recommended)</option>
                      <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                      <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                      <option value="gemini-2.5-pro">gemini-2.5-pro</option>
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
                      <span className="status-badge offline">📁 Local Vault Mode</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#667781', marginTop: 8 }}>
                    {isSupabaseEnabled
                      ? 'Files and metadata are automatically synced with your Supabase Cloud project.'
                      : 'Running in local filesystem mode. To enable Cloud Storage, set SUPABASE_URL and SUPABASE_KEY in your server environment variables.'}
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
                      <span>Supabase <code>service_role</code> or <code>anon</code> key</span>
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
FOR DELETE USING (bucket_id = 'documents');`}
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
    </div>
  );
}
