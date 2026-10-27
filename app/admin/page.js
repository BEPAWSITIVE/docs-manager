'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

export default function AdminPage() {
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });

  // System Settings State
  const [systemSettings, setSystemSettings] = useState({
    allow_random_uploads: false,
    strict_owner_fetch: true,
  });

  // Selected Client Edit State
  const [editForm, setEditForm] = useState({
    name: '',
    phone_number: '',
    notes: '',
    is_active: true,
    allow_random_uploads: false,
  });

  // Onboard New Client Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newClient, setNewClient] = useState({
    name: '',
    phone_number: '',
    notes: '',
    is_active: true,
    allow_random_uploads: false,
  });
  const [addingClient, setAddingClient] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

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

      // Auto-select first client if available
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

  const selectClient = (client) => {
    if (!client) return;
    setSelectedClientId(client.client_id);
    setEditForm({
      name: client.name || '',
      phone_number: client.phone_number || '',
      notes: client.notes || '',
      is_active: client.is_active !== false,
      allow_random_uploads: Boolean(client.allow_random_uploads),
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

  // Save changes to selected client
  const handleSaveSelectedClient = async (e) => {
    e.preventDefault();
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
        showMessage(`Settings saved for "${updated.name}"!`, 'success');
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

  // Instant Auto-Save Toggle for Client-level is_active
  const handleToggleClientActive = async (checked) => {
    setEditForm((prev) => ({ ...prev, is_active: checked }));
    if (!selectedClientId) return;

    try {
      const res = await fetch(`/api/clients/${selectedClientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: checked }),
      });
      if (res.ok) {
        const data = await res.json();
        const updated = data.client;
        setClients((prev) =>
          prev.map((c) => (c.client_id === selectedClientId ? updated : c))
        );
        showMessage(
          checked
            ? `✓ Client "${updated.name}" is now AUTHORIZED.`
            : `✓ Client "${updated.name}" access REVOKED.`,
          'success'
        );
      }
    } catch (err) {
      showMessage('Error updating client status.', 'error');
    }
  };

  // Toggle global allow_random_uploads
  const handleToggleGlobalRandomUploads = async (enabled) => {
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
            ? 'Global Setting: Random numbers CAN now upload documents.'
            : 'Global Setting: Random numbers BLOCKED from uploading (Owner only).',
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
          allow_random_uploads: false,
        });
        showMessage(`Client "${created.name}" onboarded and selected!`, 'success');
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

  const selectedClient = clients.find((c) => c.client_id === selectedClientId);

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
      {/* 1. Header Bar */}
      <header className="admin-header">
        <div className="admin-header-left">
          <div className="admin-logo-badge">👑</div>
          <div>
            <h1 className="admin-header-title">Docs Manager • Admin Portal</h1>
            <div className="admin-header-sub">
              Client Onboarding, WhatsApp Owner Authorization & Document Permissions
            </div>
          </div>
        </div>

        <div className="admin-header-right">
          <span className="gateway-pill" title="Zernio WhatsApp Gateway">
            📱 WhatsApp: <code>+1 864-947-4753</code>
          </span>
          <span className="cloud-pill" title="Supabase Cloud PostgreSQL & Storage">
            ☁️ Supabase Cloud
          </span>
          <Link href="/" className="btn-chat-view" title="Return to WhatsApp Chat Interface">
            💬 Open Chat View
          </Link>
        </div>
      </header>

      {/* Main Container */}
      <main className="admin-main-container">
        {/* Status Toast */}
        {message.text && (
          <div className={`admin-toast ${message.type === 'error' ? 'toast-error' : 'toast-success'}`}>
            {message.type === 'error' ? '⚠️ ' : '✓ '} {message.text}
          </div>
        )}

        {/* 2. Top Client Selector Bar */}
        <section className="client-selector-card">
          <div className="selector-header-row">
            <div className="selector-title-col">
              <span className="section-step-num">Step 1</span>
              <h2 className="section-title">Select Client to Configure</h2>
              <p className="section-desc">
                Choose an onboarded client from the list below to customize their owner phone number, upload permissions, and access status.
              </p>
            </div>
            <button
              type="button"
              className="btn-onboard-primary"
              onClick={() => setShowAddModal(true)}
            >
              <span>➕</span> Onboard New Client
            </button>
          </div>

          <div className="selector-control-row">
            <div className="selector-select-wrapper">
              <label className="selector-label">Active Selected Client:</label>
              <select
                className="selector-dropdown"
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
            </div>

            <div className="selector-stats-grid">
              <div className="stat-pill">
                <span className="stat-pill-label">Total Clients:</span>
                <span className="stat-pill-val">{clients.length}</span>
              </div>
              <div className="stat-pill">
                <span className="stat-pill-label">Active Owners:</span>
                <span className="stat-pill-val active-green">
                  {clients.filter((c) => c.is_active).length}
                </span>
              </div>
              <div className="stat-pill">
                <span className="stat-pill-label">Global Random Uploads:</span>
                <span className={`stat-pill-val ${systemSettings.allow_random_uploads ? 'active-green' : 'dim-gray'}`}>
                  {systemSettings.allow_random_uploads ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Settings for the Selected Client */}
        <section className="client-settings-container">
          <div className="settings-section-heading">
            <span className="section-step-num">Step 2</span>
            <div>
              <h2 className="section-title">
                Settings for: <span className="highlight-client">{selectedClient ? selectedClient.name : 'No Client Selected'}</span>
              </h2>
              <div className="section-desc">
                Configure owner phone number, document upload permissions, and fetch security policies.
              </div>
            </div>
          </div>

          {selectedClient ? (
            <form onSubmit={handleSaveSelectedClient} className="settings-grid-layout">
              {/* Left Column: Owner Identity & Phone Number */}
              <div className="settings-card">
                <div className="card-header-styled">
                  <span className="card-header-icon">👤</span>
                  <div>
                    <h3 className="card-header-title">Owner Identity & WhatsApp Number</h3>
                    <p className="card-header-sub">Primary authorized contact for this client account</p>
                  </div>
                </div>

                <div className="card-body-styled">
                  <div className="form-field-group">
                    <label className="input-label">Client / Organization Name *</label>
                    <input
                      type="text"
                      className="text-input"
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      placeholder="e.g. Swastik Sharma"
                      required
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="input-label">
                      Owner WhatsApp Phone Number *
                      <span className="input-hint">(Include country code, e.g. +91 7678106554)</span>
                    </label>
                    <input
                      type="text"
                      className="text-input phone-font"
                      value={editForm.phone_number}
                      onChange={(e) => setEditForm({ ...editForm, phone_number: e.target.value })}
                      placeholder="+91 7678106554"
                      required
                    />
                    <div className="field-note">
                      🔒 This number has full owner privileges to fetch and upload documents on WhatsApp.
                    </div>
                  </div>

                  <div className="form-field-group">
                    <label className="input-label">Notes / Company Details</label>
                    <textarea
                      className="textarea-input"
                      rows={2}
                      value={editForm.notes}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                      placeholder="e.g. Primary Owner / Verified Gateway"
                    />
                  </div>
                </div>
              </div>

              {/* Right Column: Customization Settings & Permissions (The Toggles!) */}
              <div className="settings-card">
                <div className="card-header-styled">
                  <span className="card-header-icon">⚙️</span>
                  <div>
                    <h3 className="card-header-title">Document Permissions & Customization</h3>
                    <p className="card-header-sub">Configure how AI processes uploads and fetch queries</p>
                  </div>
                </div>

                <div className="card-body-styled">
                  {/* TOGGLE 1: Allow Random Number to Upload Document */}
                  <div className="permission-toggle-box">
                    <div className="toggle-left">
                      <div className="toggle-label-row">
                        <span className="toggle-title">Allow Random Numbers to Upload Documents</span>
                        <span className={`toggle-state-badge ${editForm.allow_random_uploads ? 'badge-on' : 'badge-off'}`}>
                          {editForm.allow_random_uploads ? 'ALLOWED (Public)' : 'RESTRICTED (Owner Only)'}
                        </span>
                      </div>
                      <p className="toggle-description">
                        <strong>When Enabled:</strong> Anyone (any unknown WhatsApp number) can send documents or images to the AI bot (+1 864-947-4753). The AI will analyze them, store metadata in this vault, and reply with <code>👍</code> + bulleted metadata points.
                        <br />
                        <strong>When Disabled:</strong> Only the authorized owner phone number can upload documents. Uploads from any other numbers are silently ignored.
                      </p>
                    </div>

                    <label className="switch-toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.allow_random_uploads)}
                        onChange={(e) => handleToggleClientRandomUploads(e.target.checked)}
                      />
                      <span className="slider round"></span>
                    </label>
                  </div>

                  {/* SETTING 2: Document Fetch Security Policy (Strict Owner Only) */}
                  <div className="policy-info-box">
                    <div className="policy-info-header">
                      <span className="policy-icon">🛡️</span>
                      <strong>Strict Owner-Only Fetch Security:</strong>
                      <span className="policy-badge-enforced">Always Enforced</span>
                    </div>
                    <p className="policy-info-text">
                      Only the authorized owner number (<code>{editForm.phone_number || 'Owner Number'}</code>) can fetch documents. Any unauthorized number asking to fetch documents receives <strong>ZERO response</strong> (complete silence).
                    </p>
                  </div>

                  {/* TOGGLE 3: Client Account Active Status */}
                  <div className="permission-toggle-box status-toggle-box">
                    <div className="toggle-left">
                      <div className="toggle-label-row">
                        <span className="toggle-title">Client Account Authorization Status</span>
                        <span className={`toggle-state-badge ${editForm.is_active ? 'badge-on' : 'badge-off'}`}>
                          {editForm.is_active ? 'AUTHORIZED' : 'REVOKED / SUSPENDED'}
                        </span>
                      </div>
                      <p className="toggle-description">
                        When active, this client owner can interact with the WhatsApp AI assistant. If revoked, all bot interactions are paused.
                      </p>
                    </div>

                    <label className="switch-toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.is_active)}
                        onChange={(e) => handleToggleClientActive(e.target.checked)}
                      />
                      <span className="slider round"></span>
                    </label>
                  </div>
                </div>

                {/* Action Footer */}
                <div className="card-footer-styled">
                  <button
                    type="button"
                    className="btn-danger-outline"
                    onClick={() => handleDeleteClient(selectedClient.client_id, selectedClient.name)}
                  >
                    🗑️ Delete Client
                  </button>

                  <button
                    type="submit"
                    className="btn-save-primary"
                    disabled={saving}
                  >
                    {saving ? 'Saving Changes...' : '💾 Save Settings'}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="no-client-selected-card">
              <span className="empty-icon">📁</span>
              <h3>No Client Selected</h3>
              <p>Please select a client from the top dropdown or onboard a new client to configure settings.</p>
              <button
                type="button"
                className="btn-onboard-primary"
                onClick={() => setShowAddModal(true)}
              >
                ➕ Onboard First Client
              </button>
            </div>
          )}
        </section>

        {/* 4. Global Settings & Bot Controls */}
        <section className="global-settings-card">
          <div className="global-settings-header">
            <div>
              <h3 className="section-title">🌐 Global Bot Upload Customization</h3>
              <p className="section-desc">
                Configure whether the WhatsApp bot accepts document uploads globally from any sender or restricts uploads to registered clients.
              </p>
            </div>
            <div className="global-toggle-wrapper">
              <span className="global-toggle-label">
                Global Random Uploads: <strong>{systemSettings.allow_random_uploads ? 'ON' : 'OFF'}</strong>
              </span>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(systemSettings.allow_random_uploads)}
                  onChange={(e) => handleToggleGlobalRandomUploads(e.target.checked)}
                />
                <span className="slider round"></span>
              </label>
            </div>
          </div>
        </section>

        {/* 5. Master Clients Directory Table */}
        <section className="clients-directory-card">
          <div className="directory-header-row">
            <div>
              <h3 className="section-title">📋 Master Onboarded Clients Directory ({clients.length})</h3>
              <p className="section-desc">Overview of all clients, authorized owner numbers, and upload policies.</p>
            </div>

            <div className="directory-actions-row">
              <input
                type="text"
                className="search-input"
                placeholder="Search by name or phone..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button
                type="button"
                className="btn-refresh"
                onClick={fetchInitialData}
                title="Reload Clients"
              >
                🔄 Refresh
              </button>
            </div>
          </div>

          <div className="table-responsive">
            <table className="directory-table">
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
                    <td colSpan={6} className="text-center-cell">
                      {searchQuery ? 'No clients match your search query.' : 'No clients onboarded yet.'}
                    </td>
                  </tr>
                ) : (
                  filteredClients.map((c) => {
                    const isCurrent = c.client_id === selectedClientId;
                    return (
                      <tr key={c.client_id} className={isCurrent ? 'selected-row' : ''}>
                        <td className="client-name-td">
                          <strong>{c.name}</strong>
                          {isCurrent && <span className="active-marker">● Active Selected</span>}
                        </td>
                        <td>
                          <code className="phone-tag">{c.phone_number}</code>
                        </td>
                        <td>
                          <span
                            className={`badge-pill ${
                              c.allow_random_uploads || systemSettings.allow_random_uploads
                                ? 'badge-allowed'
                                : 'badge-owner-only'
                            }`}
                          >
                            {c.allow_random_uploads || systemSettings.allow_random_uploads
                              ? '✓ Random Uploads Allowed'
                              : '🔒 Owner Only'}
                          </span>
                        </td>
                        <td>
                          <span className={`badge-pill ${c.is_active ? 'badge-authorized' : 'badge-revoked'}`}>
                            {c.is_active ? '● Authorized' : '○ Revoked'}
                          </span>
                        </td>
                        <td className="notes-td">{c.notes || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn-table-edit"
                            onClick={() => selectClient(c)}
                            title="Configure this client above"
                          >
                            ✏️ Configure
                          </button>
                          <button
                            type="button"
                            className="btn-table-del"
                            onClick={() => handleDeleteClient(c.client_id, c.name)}
                            title="Delete client"
                          >
                            🗑️
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* 6. Onboard New Client Modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-header">
              <div>
                <h3 className="modal-title">➕ Onboard New Client</h3>
                <p className="modal-sub">Register an authorized owner phone number and configure upload policies</p>
              </div>
              <button
                type="button"
                className="modal-close-x"
                onClick={() => setShowAddModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateClient} className="modal-body-form">
              <div className="form-field-group">
                <label className="input-label">Client / Organization Name *</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. Swastik Enterprises"
                  value={newClient.name}
                  onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
                  required
                />
              </div>

              <div className="form-field-group">
                <label className="input-label">
                  Owner WhatsApp Phone Number *
                  <span className="input-hint">(with country code, e.g. +91 7678106554)</span>
                </label>
                <input
                  type="text"
                  className="text-input phone-font"
                  placeholder="+91 7678106554"
                  value={newClient.phone_number}
                  onChange={(e) => setNewClient({ ...newClient, phone_number: e.target.value })}
                  required
                />
              </div>

              <div className="form-field-group">
                <label className="input-label">Notes / Company (Optional)</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. Co-founder / Authorized Access"
                  value={newClient.notes}
                  onChange={(e) => setNewClient({ ...newClient, notes: e.target.value })}
                />
              </div>

              {/* Upload Customization Toggle in Onboarding Modal */}
              <div className="permission-toggle-box" style={{ marginTop: 12 }}>
                <div className="toggle-left">
                  <div className="toggle-label-row">
                    <span className="toggle-title">Allow Random Numbers to Upload Documents</span>
                  </div>
                  <p className="toggle-description">
                    Allow anyone sending photos/documents on WhatsApp to have them analyzed and indexed under this client vault.
                  </p>
                </div>
                <label className="switch-toggle">
                  <input
                    type="checkbox"
                    checked={newClient.allow_random_uploads}
                    onChange={(e) =>
                      setNewClient({ ...newClient, allow_random_uploads: e.target.checked })
                    }
                  />
                  <span className="slider round"></span>
                </label>
              </div>

              <div className="modal-footer-row">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-save-primary"
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
