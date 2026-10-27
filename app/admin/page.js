'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [copiedPhone, setCopiedPhone] = useState(false);

  // System Settings State
  const [systemSettings, setSystemSettings] = useState({
    allow_random_uploads: true,
    strict_owner_fetch: true,
  });

  // Selected Client Edit State
  const [editForm, setEditForm] = useState({
    name: 'peepal farm',
    phone_number: '+91 7678106554',
    notes: 'Verified Owner (WhatsApp +1 864-947-4753 Gateway)',
    is_active: true,
    allow_random_uploads: true,
  });

  // Onboard New Client Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newClient, setNewClient] = useState({
    name: '',
    phone_number: '',
    notes: '',
    is_active: true,
    allow_random_uploads: true,
  });
  const [addingClient, setAddingClient] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Recent Webhook Logs State (for Logs Tab)
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Load clients and settings on mount
  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    try {
      setLoading(true);
      const [clientsRes, settingsRes] = await Promise.all([
        fetch('/api/clients'),
        fetch('/api/settings'),
      ]);

      let loadedClients = [];
      if (clientsRes.ok) {
        const cData = await clientsRes.json();
        loadedClients = cData.clients || [];
        setClients(loadedClients);
      }

      if (settingsRes.ok) {
        const sData = await settingsRes.json();
        if (sData.settings) {
          setSystemSettings(sData.settings);
        }
      }

      if (loadedClients.length > 0) {
        selectClient(loadedClients[0]);
      }
    } catch (err) {
      console.error('Failed to load admin data:', err);
      showMessage('Error loading clients or settings.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    try {
      setLoadingLogs(true);
      const res = await fetch('/api/zernio/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.recent_logs || []);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setLoadingLogs(false);
    }
  };

  const selectClient = (client) => {
    if (!client) return;
    setSelectedClientId(client.client_id);
    setEditForm({
      name: client.name || '',
      phone_number: client.phone_number || '',
      notes: client.notes || '',
      is_active: client.is_active !== false,
      allow_random_uploads: client.allow_random_uploads !== false,
    });
    setMessage({ text: '', type: '' });
  };

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: '' }), 4000);
  };

  const handleClientSelectChange = (e) => {
    const cid = e.target.value;
    const client = clients.find((c) => c.client_id === cid);
    if (client) {
      selectClient(client);
    }
  };

  // Instant Auto-Save Toggle for Client-level allow_random_uploads
  const handleToggleClientRandomUploads = async (checked) => {
    setEditForm((prev) => ({ ...prev, allow_random_uploads: checked }));
    if (!selectedClientId) return;

    try {
      const res = await fetch(`/api/clients/${selectedClientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_random_uploads: checked }),
      });
      if (res.ok) {
        const data = await res.json();
        const updated = data.client;
        setClients((prev) =>
          prev.map((c) => (c.client_id === selectedClientId ? updated : c))
        );
        showMessage(
          checked
            ? `✓ Random numbers CAN now upload documents for "${updated.name}".`
            : `✓ Random uploads DISABLED for "${updated.name}" (Owner only).`,
          'success'
        );
      }
    } catch (err) {
      showMessage('Error saving upload toggle.', 'error');
    }
  };

  // Save changes to selected client
  const handleSaveSelectedClient = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!selectedClientId) return;
    if (!editForm.name.trim() || !editForm.phone_number.trim()) {
      showMessage('Client name and phone number cannot be empty.', 'error');
      return;
    }

    try {
      setSaving(true);
      const res = await fetch(`/api/clients/${selectedClientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });

      if (res.ok) {
        const data = await res.json();
        const updated = data.client;
        setClients((prev) =>
          prev.map((c) => (c.client_id === selectedClientId ? updated : c))
        );
        showMessage(`✓ Settings saved for "${updated.name}"!`, 'success');
      } else {
        const err = await res.json();
        showMessage(err.detail || 'Failed to update client.', 'error');
      }
    } catch (err) {
      showMessage('Network error while saving client.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Toggle global allow_random_uploads
  const handleToggleGlobalRandomUploads = async (enabled) => {
    setSystemSettings((prev) => ({ ...prev, allow_random_uploads: enabled }));
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_random_uploads: enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setSystemSettings(data.settings);
        showMessage(
          enabled
            ? '✓ Global Setting: Random numbers CAN now upload documents.'
            : '✓ Global Setting: Random numbers BLOCKED from uploading (Owner only).',
          'success'
        );
      }
    } catch (err) {
      showMessage('Error saving global settings.', 'error');
    }
  };

  // Delete client
  const handleDeleteClient = async (clientId, clientName) => {
    if (!confirm(`Are you sure you want to revoke access and remove "${clientName}"?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const remaining = clients.filter((c) => c.client_id !== clientId);
        setClients(remaining);
        showMessage(`Client "${clientName}" removed.`, 'success');
        if (remaining.length > 0) {
          selectClient(remaining[0]);
        } else {
          setSelectedClientId('');
          setEditForm({ name: '', phone_number: '', notes: '', is_active: true, allow_random_uploads: false });
        }
      }
    } catch (err) {
      showMessage('Error removing client.', 'error');
    }
  };

  // Create new client
  const handleCreateClient = async (e) => {
    e.preventDefault();
    if (!newClient.name.trim() || !newClient.phone_number.trim()) {
      alert('Please fill out client name and phone number.');
      return;
    }

    try {
      setAddingClient(true);
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newClient),
      });

      if (res.ok) {
        const data = await res.json();
        const created = data.client;
        setClients([created, ...clients]);
        selectClient(created);
        setShowAddModal(false);
        setNewClient({
          name: '',
          phone_number: '',
          notes: '',
          is_active: true,
          allow_random_uploads: true,
        });
        showMessage(`✓ Client "${created.name}" onboarded and selected!`, 'success');
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to onboard client.');
      }
    } catch (err) {
      alert('Network error while creating client.');
    } finally {
      setAddingClient(false);
    }
  };

  const copyToClipboard = (text) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedPhone(true);
      setTimeout(() => setCopiedPhone(false), 2000);
    }
  };

  const selectedClient = clients.find((c) => c.client_id === selectedClientId) || (clients.length > 0 ? clients[0] : null);

  const filteredClients = clients.filter((c) => {
    const q = searchQuery.toLowerCase();
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone_number || '').includes(q) ||
      (c.notes || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="admin-page-root">
      {/* 1. TOP NAVBAR */}
      <header className="top-navbar">
        <div className="top-navbar-left">
          <div className="brand-logo-box">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect width="24" height="24" rx="6" fill="#4f46e5" />
              <path d="M5 16L7 8L12 12L17 8L19 16H5Z" fill="#fbbf24" stroke="#fbbf24" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="5" cy="16" r="1.5" fill="#fef3c7" />
              <circle cx="12" cy="16" r="1.5" fill="#fef3c7" />
              <circle cx="19" cy="16" r="1.5" fill="#fef3c7" />
            </svg>
          </div>
          <div className="brand-info">
            <h1 className="brand-title">Docs Manager</h1>
            <p className="brand-sub">Client Onboarding, WhatsApp Owner Authorization & Document Permissions</p>
          </div>
        </div>

        <div className="top-navbar-right">
          {/* WhatsApp Badge */}
          <div className="nav-status-badge whatsapp-badge" title="WhatsApp Gateway">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
            </svg>
            <span>WhatsApp: <strong>+1 864-947-4753</strong></span>
          </div>

          {/* Supabase Badge */}
          <div className="nav-status-badge supabase-badge" title="Supabase Cloud PostgreSQL & Storage">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            </svg>
            <span>Supabase Cloud</span>
          </div>

          {/* Open Chat View Button */}
          <Link href="/" className="btn-open-chat" title="Switch to WhatsApp Chat view">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Open Chat View</span>
            <span className="arrow-icon">→</span>
          </Link>
        </div>
      </header>

      {/* 2. MAIN LAYOUT (SIDEBAR + CONTENT) */}
      <div className="admin-body-layout">
        {/* LEFT SIDEBAR */}
        <aside className="admin-sidebar">
          <nav className="sidebar-nav-list">
            <button
              type="button"
              className={`sidebar-nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span>Dashboard</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${activeTab === 'clients' ? 'active' : ''}`}
              onClick={() => setActiveTab('clients')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span>Clients</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('logs');
                fetchLogs();
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <span>Logs</span>
            </button>
          </nav>

          {/* Bottom Profile Pill */}
          <div className="sidebar-bottom-pill">
            <div className="avatar-circle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#4f46e5">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            </div>
            <div className="profile-text">
              <span className="profile-name">Docs Manager</span>
              <span className="profile-role">Admin Portal</span>
            </div>
            <span className="chevron-right">›</span>
          </div>
        </aside>

        {/* RIGHT MAIN CONTENT AREA */}
        <main className="admin-content-area">
          {/* Toast Message */}
          {message.text && (
            <div className={`admin-toast ${message.type === 'error' ? 'toast-error' : 'toast-success'}`}>
              {message.type === 'error' ? '⚠️ ' : '✓ '} {message.text}
            </div>
          )}

          {/* ==============================================================
              VIEW A: DASHBOARD / CLIENTS TAB
              ============================================================== */}
          {(activeTab === 'dashboard' || activeTab === 'clients') && (
            <div className="dashboard-content-stack">
              {/* STEP 1: Select Client Card */}
              <section className="admin-card step1-card">
                <div className="step1-top-row">
                  <div className="step1-left-meta">
                    <span className="step-tag">STEP 1</span>
                    <h2 className="step-title">Select Client to Configure</h2>
                    <p className="step-description">
                      Choose an onboarded client from the list below to customize their owner phone number, upload permissions, and access status.
                    </p>

                    {/* Custom Styled Select Dropdown matching screenshot */}
                    <div className="client-select-box">
                      <div className="select-icon-circle">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="#4f46e5">
                          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                        </svg>
                      </div>
                      <select
                        className="custom-client-select"
                        value={selectedClientId}
                        onChange={handleClientSelectChange}
                        disabled={loading || clients.length === 0}
                      >
                        {clients.length === 0 ? (
                          <option value="">No clients found. Click &quot;Onboard New Client&quot; to begin.</option>
                        ) : (
                          clients.map((c) => (
                            <option key={c.client_id} value={c.client_id}>
                              {c.name} — {c.phone_number} [{c.is_active ? 'Authorized' : 'Revoked'} • Random Uploads: {c.allow_random_uploads ? 'ON' : 'OFF'}]
                            </option>
                          ))
                        )}
                      </select>
                      <span className="select-chevron-icon">⌄</span>
                    </div>
                  </div>

                  <div className="step1-right-meta">
                    <button
                      type="button"
                      className="btn-onboard-purple"
                      onClick={() => setShowAddModal(true)}
                    >
                      <span>＋</span> Onboard New Client
                    </button>

                    {/* Stat Badges Row (Total Clients, Active Owners, Global Uploads) */}
                    <div className="stat-cards-trio">
                      <div className="stat-badge-box">
                        <div className="stat-icon-round purple-bg">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="#4f46e5">
                            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                          </svg>
                        </div>
                        <div className="stat-text-col">
                          <span className="stat-label">Total Clients</span>
                          <span className="stat-num">{clients.length}</span>
                        </div>
                      </div>

                      <div className="stat-badge-box">
                        <div className="stat-icon-round blue-bg">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="#0284c7">
                            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                          </svg>
                        </div>
                        <div className="stat-text-col">
                          <span className="stat-label">Active Owners</span>
                          <span className="stat-num">{clients.filter((c) => c.is_active).length}</span>
                        </div>
                      </div>

                      <div className="stat-badge-box">
                        <div className="stat-icon-round cyan-bg">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="2" y1="12" x2="22" y2="12" />
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                          </svg>
                        </div>
                        <div className="stat-text-col">
                          <span className="stat-label">Global Random Uploads</span>
                          <span className="badge-enabled-pill">ENABLED</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* STEP 2: Settings for Selected Client Header */}
              <div className="step2-header-section">
                <span className="step-tag">STEP 2</span>
                <div className="step2-title-box">
                  <h2 className="step2-heading">
                    Settings for: <span className="client-purple-text">{selectedClient ? selectedClient.name : 'peepal farm'}</span>
                  </h2>
                  <p className="step2-sub">
                    Configure owner phone number, document upload permissions, and fetch security policies.
                  </p>
                </div>
              </div>

              {/* STEP 2: Two Column Grid (Left: Owner Identity / Right: Permissions) */}
              <div className="two-col-grid">
                {/* Column 1: Owner Identity & WhatsApp Number */}
                <div className="admin-card form-card">
                  <div className="card-top-header">
                    <div className="card-top-icon purple-bg">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="#4f46e5">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="card-title">Owner Identity & WhatsApp Number</h3>
                      <p className="card-sub">Primary authorized contact for this client account.</p>
                    </div>
                  </div>

                  <div className="card-form-body">
                    {/* Client / Organization Name */}
                    <div className="input-group">
                      <label className="input-label">Client / Organization Name *</label>
                      <div className="input-icon-box">
                        <div className="input-prefix-icon gray-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                            <rect x="4" y="2" width="16" height="20" rx="2" />
                            <path d="M9 22v-4h6v4" />
                            <line x1="8" y1="6" x2="8.01" y2="6" />
                            <line x1="16" y1="6" x2="16.01" y2="6" />
                            <line x1="8" y1="10" x2="8.01" y2="10" />
                            <line x1="16" y1="10" x2="16.01" y2="10" />
                            <line x1="8" y1="14" x2="8.01" y2="14" />
                            <line x1="16" y1="14" x2="16.01" y2="14" />
                          </svg>
                        </div>
                        <input
                          type="text"
                          className="styled-input with-prefix"
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          onBlur={handleSaveSelectedClient}
                          placeholder="e.g. peepal farm"
                        />
                      </div>
                    </div>

                    {/* Owner WhatsApp Phone Number */}
                    <div className="input-group">
                      <div className="label-with-hint">
                        <label className="input-label">Owner WhatsApp Phone Number *</label>
                        <span className="input-hint">(Include country code, e.g. +91 7678106554)</span>
                      </div>
                      <div className="input-icon-box">
                        <div className="input-prefix-icon green-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="#10b981">
                            <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
                          </svg>
                        </div>
                        <input
                          type="text"
                          className="styled-input with-prefix phone-bold"
                          value={editForm.phone_number}
                          onChange={(e) => setEditForm({ ...editForm, phone_number: e.target.value })}
                          onBlur={handleSaveSelectedClient}
                          placeholder="+91 7678106554"
                        />
                      </div>
                      <div className="input-success-note">
                        <span className="green-lock-icon">🔒</span>
                        <span>This number has full owner privileges to fetch and upload documents on WhatsApp.</span>
                      </div>
                    </div>

                    {/* Notes / Company Details */}
                    <div className="input-group">
                      <label className="input-label">Notes / Company Details</label>
                      <textarea
                        className="styled-textarea"
                        rows={2}
                        value={editForm.notes}
                        onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                        onBlur={handleSaveSelectedClient}
                        placeholder="Verified Owner (WhatsApp +1 864-947-4753 Gateway)"
                      />
                    </div>
                  </div>
                </div>

                {/* Column 2: Document Permissions & Customization */}
                <div className="admin-card form-card">
                  <div className="card-top-header">
                    <div className="card-top-icon purple-bg">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="card-title">Document Permissions & Customization</h3>
                      <p className="card-sub">Configure how AI processes uploads and fetch queries.</p>
                    </div>
                  </div>

                  <div className="card-form-body">
                    {/* Box 1: Allow Random Numbers to Upload Documents (The Toggle!) */}
                    <div className="custom-setting-box green-tint-box">
                      <div className="setting-box-icon green-box-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                        </svg>
                      </div>

                      <div className="setting-box-content">
                        <div className="setting-title-row">
                          <h4 className="setting-heading">Allow Random Numbers to Upload Documents</h4>
                          <span className={`pill-status-tag ${editForm.allow_random_uploads ? 'pill-green' : 'pill-red'}`}>
                            {editForm.allow_random_uploads ? 'ALLOWED (PUBLIC)' : 'RESTRICTED'}
                          </span>
                        </div>
                        <p className="setting-explainer">
                          <strong>When Enabled:</strong> Anyone (any unknown WhatsApp number) can send documents or images to the AI bot (+1 864-947-4753). The AI will analyze them, store metadata in this vault, and reply with 👍 + bulleted metadata points.
                          <br />
                          <strong>When Disabled:</strong> Only the authorized owner phone number can upload documents. Uploads from any other numbers are silently ignored.
                        </p>
                      </div>

                      {/* iOS Style Green Toggle Switch */}
                      <label className="ios-switch">
                        <input
                          type="checkbox"
                          checked={Boolean(editForm.allow_random_uploads)}
                          onChange={(e) => handleToggleClientRandomUploads(e.target.checked)}
                        />
                        <span className="ios-slider"></span>
                      </label>
                    </div>

                    {/* Box 2: Strict Owner-Only Fetch Security (Always Enforced) */}
                    <div className="custom-setting-box blue-tint-box">
                      <div className="setting-box-icon blue-box-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="#3b82f6">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                      </div>

                      <div className="setting-box-content">
                        <div className="setting-title-row">
                          <h4 className="setting-heading">Strict Owner-Only Fetch Security:</h4>
                          <span className="pill-status-tag pill-blue">Always Enforced</span>
                        </div>
                        <p className="setting-explainer blue-text">
                          Only the authorized owner number (<strong>{editForm.phone_number || '+91 7678106554'}</strong>) can fetch documents. Any unauthorized number asking to fetch documents receives <strong>ZERO response</strong> (complete silence).
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Global Bot Upload Customization Card */}
              <section className="admin-card global-custom-card">
                <div className="global-card-left">
                  <div className="card-top-icon purple-bg">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="card-title">Global Bot Upload Customization</h3>
                    <p className="card-sub">Configure whether the WhatsApp bot accepts document uploads globally from any sender or restricts uploads to registered clients.</p>
                  </div>
                </div>

                <div className="global-card-right">
                  <span className="global-toggle-label">
                    Global Random Uploads: <strong>{systemSettings.allow_random_uploads ? 'ON' : 'OFF'}</strong>
                  </span>
                  <label className="ios-switch">
                    <input
                      type="checkbox"
                      checked={Boolean(systemSettings.allow_random_uploads)}
                      onChange={(e) => handleToggleGlobalRandomUploads(e.target.checked)}
                    />
                    <span className="ios-slider"></span>
                  </label>
                </div>
              </section>

              {/* Master Onboarded Clients Directory Table Card */}
              <section className="admin-card directory-card">
                <div className="directory-top-bar">
                  <div className="directory-heading-col">
                    <div className="card-top-icon purple-bg">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="#4f46e5">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="card-title">Master Onboarded Clients Directory ({clients.length})</h3>
                      <p className="card-sub">Overview of all clients, authorized owner numbers, and upload policies.</p>
                    </div>
                  </div>

                  <div className="directory-search-tools">
                    <div className="search-input-wrapper">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        className="clean-search-input"
                        placeholder="Search by name or phone..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-outline-refresh"
                      onClick={fetchInitialData}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                      <span>Refresh</span>
                    </button>
                  </div>
                </div>

                {/* Clients Table matching screenshot */}
                <div className="clients-table-outer">
                  <table className="clean-styled-table">
                    <thead>
                      <tr>
                        <th>Client Name</th>
                        <th>Authorized Owner WhatsApp</th>
                        <th>Random Uploads</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredClients.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="empty-table-cell">
                            {searchQuery ? 'No clients match your search query.' : 'No clients onboarded yet.'}
                          </td>
                        </tr>
                      ) : (
                        filteredClients.map((c) => {
                          const isCurrent = c.client_id === selectedClientId;
                          return (
                            <tr key={c.client_id} className={isCurrent ? 'selected-table-row' : ''}>
                              {/* Client Name with leaf/plant icon */}
                              <td className="client-identity-td">
                                <div className="client-leaf-icon">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#10b981">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                                  </svg>
                                </div>
                                <div className="client-text-block">
                                  <span className="client-bold-name">{c.name}</span>
                                  {isCurrent && (
                                    <span className="active-selected-subtag">
                                      <span className="green-dot">●</span> Active Selected
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Authorized Owner WhatsApp with Copy Button */}
                              <td>
                                <div className="phone-copy-pill" onClick={() => copyToClipboard(c.phone_number)} title="Click to copy">
                                  <span>{c.phone_number}</span>
                                  <button type="button" className="copy-icon-btn">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                    </svg>
                                  </button>
                                </div>
                              </td>

                              {/* Random Uploads Status Badge */}
                              <td>
                                <span className={`table-badge ${c.allow_random_uploads !== false ? 'badge-green' : 'badge-gray'}`}>
                                  {c.allow_random_uploads !== false ? '✓ Random Uploads Allowed' : '🔒 Owner Only'}
                                </span>
                              </td>

                              {/* Status Badge */}
                              <td>
                                <span className={`table-badge ${c.is_active ? 'badge-green' : 'badge-red'}`}>
                                  {c.is_active ? '● Authorized' : '○ Revoked'}
                                </span>
                              </td>

                              {/* Notes */}
                              <td className="table-notes-cell">{c.notes || '—'}</td>

                              {/* Actions */}
                              <td style={{ textAlign: 'right' }}>
                                <div className="table-actions-group">
                                  <button
                                    type="button"
                                    className="btn-configure-action"
                                    onClick={() => selectClient(c)}
                                    title="Edit settings for this client above"
                                  >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.2">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                    </svg>
                                    <span>Configure</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-more-dots"
                                    onClick={() => handleDeleteClient(c.client_id, c.name)}
                                    title="Delete client"
                                  >
                                    ⋮
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {/* ==============================================================
              VIEW B: SETTINGS TAB
              ============================================================== */}
          {activeTab === 'settings' && (
            <div className="tab-pane-card">
              <h2 className="step-title">System & Cloud Configuration</h2>
              <p className="step-description">Manage API keys, database connection, and webhook credentials.</p>

              <div className="custom-setting-box" style={{ marginTop: 20 }}>
                <div className="setting-box-content">
                  <h4 className="setting-heading">Supabase Cloud Database & Storage</h4>
                  <p className="setting-explainer">
                    Connected to Supabase project URL: <code>bxaqfnaxiegsfxmffgqo.supabase.co</code> (Storage Bucket: <code>documents</code>).
                  </p>
                </div>
                <span className="pill-status-tag pill-green">Connected</span>
              </div>

              <div className="custom-setting-box" style={{ marginTop: 14 }}>
                <div className="setting-box-content">
                  <h4 className="setting-heading">Zernio WhatsApp Webhook</h4>
                  <p className="setting-explainer">
                    Webhook Endpoint: <code>/api/zernio/webhook</code> (Events: <code>message.received</code>).
                  </p>
                </div>
                <span className="pill-status-tag pill-green">Online</span>
              </div>
            </div>
          )}

          {/* ==============================================================
              VIEW C: LOGS TAB
              ============================================================== */}
          {activeTab === 'logs' && (
            <div className="tab-pane-card">
              <div className="directory-top-bar" style={{ marginBottom: 16 }}>
                <div>
                  <h2 className="step-title">Activity & Webhook Logs</h2>
                  <p className="step-description">Real-time incoming WhatsApp messages, authorization checks, and AI OCR processing.</p>
                </div>
                <button type="button" className="btn-outline-refresh" onClick={fetchLogs}>
                  <span>🔄 Refresh Logs</span>
                </button>
              </div>

              {loadingLogs ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>Loading logs...</div>
              ) : logs.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>No recent logs.</div>
              ) : (
                <div className="logs-terminal-box">
                  {logs.map((log, idx) => (
                    <div key={idx} className="log-line">
                      <span className="log-time">{log.time ? new Date(log.time).toLocaleTimeString() : ''}</span>
                      <span className="log-summary">{log.summary}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* 3. ONBOARD NEW CLIENT MODAL */}
      {showAddModal && (
        <div className="modal-backdrop-blur" onClick={() => setShowAddModal(false)}>
          <div className="modal-box-styled" onClick={(e) => e.stopPropagation()}>
            <div className="modal-box-header">
              <div>
                <h3 className="modal-box-title">➕ Onboard New Client</h3>
                <p className="modal-box-sub">Register an authorized owner phone number and configure upload policies</p>
              </div>
              <button
                type="button"
                className="modal-box-close"
                onClick={() => setShowAddModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateClient} className="modal-box-body">
              <div className="input-group">
                <label className="input-label">Client / Organization Name *</label>
                <input
                  type="text"
                  className="styled-input"
                  placeholder="e.g. Swastik Enterprises"
                  value={newClient.name}
                  onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
                  required
                />
              </div>

              <div className="input-group">
                <div className="label-with-hint">
                  <label className="input-label">Owner WhatsApp Phone Number *</label>
                  <span className="input-hint">(with country code, e.g. +91 7678106554)</span>
                </div>
                <input
                  type="text"
                  className="styled-input phone-bold"
                  placeholder="+91 7678106554"
                  value={newClient.phone_number}
                  onChange={(e) => setNewClient({ ...newClient, phone_number: e.target.value })}
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Notes / Company (Optional)</label>
                <input
                  type="text"
                  className="styled-input"
                  placeholder="e.g. Co-founder / Verified Gateway"
                  value={newClient.notes}
                  onChange={(e) => setNewClient({ ...newClient, notes: e.target.value })}
                />
              </div>

              {/* Upload Permission Toggle in Modal */}
              <div className="custom-setting-box green-tint-box" style={{ marginTop: 8 }}>
                <div className="setting-box-content">
                  <div className="setting-title-row">
                    <h4 className="setting-heading">Allow Random Numbers to Upload Documents</h4>
                  </div>
                  <p className="setting-explainer">
                    Allow anyone sending photos/documents to have them analyzed and indexed in this client vault.
                  </p>
                </div>
                <label className="ios-switch">
                  <input
                    type="checkbox"
                    checked={newClient.allow_random_uploads}
                    onChange={(e) =>
                      setNewClient({ ...newClient, allow_random_uploads: e.target.checked })
                    }
                  />
                  <span className="ios-slider"></span>
                </label>
              </div>

              <div className="modal-box-footer">
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-onboard-purple"
                  disabled={addingClient}
                >
                  {addingClient ? 'Onboarding...' : 'Onboard & Register Owner'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
