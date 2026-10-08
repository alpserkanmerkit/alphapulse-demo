import React, { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Bitcoin, Globe, Factory, Zap,
  BarChart3, Shield, Swords, Lock, Crown, Wifi, WifiOff, Users, UserPlus, Trash2
} from 'lucide-react';
import { Category, UserRole } from '../types';
import { useNewsStore } from '../stores/newsStore';
import { usePortfolioStore } from '../stores/portfolioStore';
import { useAuthStore } from '../stores/authStore';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Intelligence Feed', icon: LayoutDashboard, exact: true },
  { path: '/portfolio', label: 'Portfolio & Risk', icon: BarChart3 },
  { path: '/war-room', label: 'Strategy Boardroom', icon: Swords },
  { path: '/compliance', label: 'Compliance', icon: Shield },
];

const CATEGORIES = [
  { id: Category.ALL, label: 'All Markets', icon: LayoutDashboard },
  { id: Category.CRYPTO, label: 'Crypto & DeFi', icon: Bitcoin },
  { id: Category.STOCKS, label: 'Equities', icon: TrendingUp },
  { id: Category.FOREX, label: 'Forex', icon: Globe },
  { id: Category.COMMODITIES, label: 'Commodities', icon: Factory },
  { id: Category.STARTUP, label: 'Startups & AI', icon: Zap },
  { id: Category.MACRO, label: 'Macro / Geo', icon: Globe },
];

const CURRENT_USER = {
  name: 'Demo Fund Manager',
  role: 'Fund Manager',
  tier: 'INSTITUTIONAL',
  initials: 'DF',
};

const BADGE_TONE: Record<'ready' | 'limited' | 'offline', string> = {
  ready: 'ap-badge--bull',
  limited: 'ap-badge--warn',
  offline: 'ap-badge--neutral',
};

const TEAM_ROLES: UserRole[] = ['ADMIN', 'COMPLIANCE_OFFICER', 'FUND_MANAGER', 'ANALYST'];

interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

const Sidebar: React.FC = () => {
  const { activeCategory, setActiveCategory, isStreamActive, runtimeView } = useNewsStore();
  const { portfolios, activePortfolioId, setActivePortfolio } = usePortfolioStore();
  const { token, user, setAuth } = useAuthStore();
  const [teams, setTeams] = useState<Array<{ teamId: string; teamName: string; role: string }>>([]);
  const [isTeamAdminOpen, setIsTeamAdminOpen] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<UserRole>('ANALYST');
  const [teamMessage, setTeamMessage] = useState<string | null>(null);
  const [isTeamSaving, setIsTeamSaving] = useState(false);
  const [isTeamLoading, setIsTeamLoading] = useState(false);
  const activeTeamId = user?.teamContext?.teamId ?? null;
  const activeTeamRole = user?.teamContext?.role ?? null;
  const canManageTeam = Boolean(token && activeTeamId && activeTeamRole === 'ADMIN');
  const visibleTeams = token ? teams : [];
  const visibleTeamMembers = canManageTeam && activeTeamId ? teamMembers : [];
  const statusBadges: Array<{ label: string; value: string; tone: 'ready' | 'limited' | 'offline' }> = [
    { label: 'Backend', value: runtimeView.labels.backend, tone: runtimeView.backendLive ? 'ready' : 'offline' },
    { label: 'AI', value: runtimeView.labels.ai, tone: runtimeView.aiMode === 'live' ? 'ready' : 'limited' },
    { label: 'Feed', value: runtimeView.labels.feed, tone: runtimeView.feedMode === 'live' ? 'ready' : 'limited' },
    { label: 'Quant', value: runtimeView.labels.quant, tone: runtimeView.quantStatus === 'reachable' ? 'ready' : 'limited' },
    {
      label: 'Compliance',
      value: runtimeView.labels.compliance,
      tone: runtimeView.complianceStatus === 'ready' ? 'ready' : runtimeView.complianceStatus === 'degraded' ? 'limited' : 'offline',
    },
  ];

  const loadTeamMembers = useCallback(async (teamId: string) => {
    setIsTeamLoading(true);
    try {
      const response = await apiClient.get(`/api/teams/${teamId}/members`);
      setTeamMembers(response.data.members ?? []);
      setTeamMessage(null);
    } catch (error) {
      setTeamMembers([]);
      setTeamMessage(getApiErrorMessage(error, 'Failed to load team members.'));
    } finally {
      setIsTeamLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    void apiClient.get('/api/teams')
      .then((response) => {
        if (!cancelled) setTeams(response.data.teams ?? []);
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeTeamId]);

  useEffect(() => {
    if (!canManageTeam || !activeTeamId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadTeamMembers(activeTeamId);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [canManageTeam, activeTeamId, loadTeamMembers]);

  const switchTeam = async (teamId: string) => {
    if (!teamId || teamId === activeTeamId) return;
    const response = await apiClient.post(`/api/teams/${teamId}/switch`, {});
    if (response.data.token && response.data.user) {
      setAuth(response.data.token, response.data.user);
    }
  };

  const addTeamMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeTeamId || !newMemberEmail.trim()) return;
    setIsTeamSaving(true);
    try {
      await apiClient.post(`/api/teams/${activeTeamId}/members`, {
        email: newMemberEmail.trim(),
        role: newMemberRole,
      });
      setNewMemberEmail('');
      setTeamMessage('Team member saved.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to save team member.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  const updateTeamMemberRole = async (member: TeamMember, role: UserRole) => {
    if (!activeTeamId || member.role === role) return;
    setIsTeamSaving(true);
    try {
      await apiClient.patch(`/api/teams/${activeTeamId}/members/${member.userId}`, { role });
      setTeamMessage('Team role updated.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to update team role.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  const removeTeamMember = async (member: TeamMember) => {
    if (!activeTeamId || member.userId === user?.id) return;
    setIsTeamSaving(true);
    try {
      await apiClient.delete(`/api/teams/${activeTeamId}/members/${member.userId}`);
      setTeamMessage('Team member removed.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to remove team member.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  return (
    <aside className="ap-sidebar">
      <div className="ap-sidebar-logo">
        <div className="ap-logo-pulse" />
        <div>
          <h1 className="ap-logo-title">ALPHAPULSE</h1>
          <p className="ap-logo-sub">INSTITUTIONAL TERMINAL</p>
        </div>
      </div>

      <nav className="ap-nav">
        <p className="ap-nav-section-label">MODULES</p>
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => `ap-nav-item ${isActive ? 'ap-nav-item--active' : ''}`}
          >
            <Icon size={17} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="ap-nav ap-nav-categories">
        <p className="ap-nav-section-label">FEED FILTER</p>
        {CATEGORIES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveCategory(id)}
            className={`ap-nav-item ${activeCategory === id ? 'ap-nav-item--active' : ''}`}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="ap-sidebar-section">
        <p className="ap-nav-section-label">ACTIVE PORTFOLIO</p>
        <select
          value={activePortfolioId}
          onChange={(e) => setActivePortfolio(e.target.value)}
          className="ap-portfolio-select"
        >
          {portfolios.map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name}
            </option>
          ))}
        </select>
      </div>

      {user && (
        <div className="ap-sidebar-section">
          <p className="ap-nav-section-label">ACTIVE TEAM</p>
          <select
            value={user.teamContext?.teamId ?? ''}
            onChange={(event) => void switchTeam(event.target.value)}
            className="ap-portfolio-select"
          >
            {(visibleTeams.length > 0 ? visibleTeams : user.teamContext ? [user.teamContext] : []).map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.teamName} ({team.role})
              </option>
            ))}
          </select>
        </div>
      )}

      {canManageTeam && activeTeamId && (
        <div className="ap-sidebar-section">
          <button
            type="button"
            className="ap-nav-item"
            onClick={() => setIsTeamAdminOpen((open) => !open)}
            style={{ width: '100%', justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Users size={15} /> Team Governance
            </span>
            <span>{visibleTeamMembers.length}</span>
          </button>

          {isTeamAdminOpen && (
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              <form onSubmit={addTeamMember} style={{ display: 'grid', gap: 6 }}>
                <input
                  className="ap-input"
                  value={newMemberEmail}
                  onChange={(event) => setNewMemberEmail(event.target.value)}
                  placeholder="member@example.com"
                  type="email"
                  style={{ fontSize: 11, padding: '8px 10px' }}
                />
                <select
                  className="ap-portfolio-select"
                  value={newMemberRole}
                  onChange={(event) => setNewMemberRole(event.target.value as UserRole)}
                >
                  {TEAM_ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <button type="submit" className="ap-btn ap-btn--ghost ap-btn--sm" disabled={isTeamSaving || !newMemberEmail.trim()}>
                  <UserPlus size={12} /> Add Existing User
                </button>
              </form>

              {teamMessage && (
                <div style={{ fontSize: 10, color: teamMessage.toLowerCase().includes('failed') ? 'var(--ap-bear)' : 'var(--ap-text-muted)' }}>
                  {teamMessage}
                </div>
              )}

              <div style={{ display: 'grid', gap: 8, maxHeight: 190, overflowY: 'auto' }}>
                {isTeamLoading ? (
                  <span style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>Loading team members...</span>
                ) : visibleTeamMembers.map((member) => (
                  <div key={member.id} style={{ display: 'grid', gap: 5, paddingBottom: 8, borderBottom: '1px solid var(--ap-border)' }}>
                    <span style={{ fontSize: 11, color: 'var(--ap-text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {member.email}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        className="ap-portfolio-select"
                        value={member.role}
                        onChange={(event) => void updateTeamMemberRole(member, event.target.value as UserRole)}
                        disabled={isTeamSaving}
                        style={{ flex: 1, fontSize: 10 }}
                      >
                        {TEAM_ROLES.map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="ap-btn ap-btn--ghost ap-btn--sm"
                        onClick={() => void removeTeamMember(member)}
                        disabled={isTeamSaving || member.userId === user?.id}
                        title={member.userId === user?.id ? 'Cannot remove the active session user here' : 'Remove member'}
                        style={{ padding: '6px 8px' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="ap-sidebar-bottom">
        <div className="ap-status-bar">
          <div className={`ap-status-indicator ${isStreamActive ? 'ap-status-indicator--live' : 'ap-status-indicator--paused'}`} />
          <span className="ap-status-label">
            {isStreamActive ? 'LIVE FEED' : 'PAUSED'}
          </span>
          <div className="ap-status-api" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span data-testid="runtime-status" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {runtimeView.backendLive ? <Wifi size={12} /> : <WifiOff size={12} />}
              {runtimeView.backendLive ? 'Runtime Online' : 'Runtime Offline'}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
              {statusBadges.map((badge) => (
                <span key={badge.label} data-testid={`runtime-badge-${badge.label.toLowerCase()}`} className={`ap-badge ${BADGE_TONE[badge.tone]}`} style={{ fontSize: 9 }}>
                  {badge.label}: {badge.value}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="ap-user-card">
          <div className="ap-user-avatar">{CURRENT_USER.initials}</div>
          <div className="ap-user-info">
            <p className="ap-user-name">{CURRENT_USER.name}</p>
            <p className="ap-user-role">
              <Crown size={10} className="inline mr-1 text-amber-400" />
              {CURRENT_USER.role}
            </p>
          </div>
          <div className="ap-tier-badge">
            <Lock size={10} />
            <span>INST</span>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
