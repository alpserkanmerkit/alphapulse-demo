import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

type TestServerOptions = Parameters<typeof withBackendTestServer>[1];

async function withTestServer(handler: (baseUrl: string) => Promise<void>, options: TestServerOptions = {}) {
    await withBackendTestServer(handler, { jwtSecret: randomBytes(48).toString('hex'), seedCompliance: false, ...options });
}

const BACKEND_CONTRACT_TIMEOUT_MS = 60_000;

// F-2: /api/auth/register returns a uniform 202 (no token); after registering, sign in with the same credentials.
async function registerAndLogin(baseUrl: string, init: RequestInit): Promise<Response> {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, init);
    expect(registerResponse.status).toBe(202);
    return fetch(`${baseUrl}/api/auth/login`, init);
}

describe('auth and portfolio contracts', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('registers, logs in with normalized email, and returns a JWT-backed user', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'Trader@Example.COM ', password: 'password123', name: 'Trader' }),
            });
            const registerPayload = await registerResponse.json();

            expect(registerResponse.status).toBe(200);
            expect(registerPayload.success).toBe(true);
            expect(registerPayload.user.email).toBe('trader@example.com');
            expect(registerPayload.user.role).toBe('ANALYST');
            expect(registerPayload.user.teamContext.teamName).toBe('AlphaPulse Compliance');
            expect(registerPayload.user.teamContext.role).toBe('ANALYST');
            expect(registerPayload.token).toEqual(expect.any(String));

            const secondRegisterResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'Second@Example.COM ', password: 'password123', name: 'Second Trader' }),
            });
            const secondRegisterPayload = await secondRegisterResponse.json();

            expect(secondRegisterResponse.status).toBe(200);
            expect(secondRegisterPayload.user.teamContext.teamId).toBe(registerPayload.user.teamContext.teamId);

            const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'TRADER@example.com', password: 'password123' }),
            });
            const loginPayload = await loginResponse.json();

            expect(loginResponse.status).toBe(200);
            expect(loginPayload.success).toBe(true);
            expect(loginPayload.user.id).toBe(registerPayload.user.id);
            expect(loginPayload.user.role).toBe('ANALYST');
            expect(loginPayload.user.teamContext.teamId).toBe(registerPayload.user.teamContext.teamId);

            const createTeamResponse = await fetch(`${baseUrl}/api/teams`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginPayload.token}` },
                body: JSON.stringify({ name: 'AlphaPulse Second Fund' }),
            });
            const createTeamPayload = await createTeamResponse.json();

            expect(createTeamResponse.status).toBe(201);
            expect(createTeamPayload.teamContext.teamId).not.toBe(registerPayload.user.teamContext.teamId);
            expect(createTeamPayload.teamContext.role).toBe('ADMIN');

            const secondTeamHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${createTeamPayload.token}` };
            const secondTeamStateResponse = await fetch(`${baseUrl}/api/portfolio/state`, { headers: secondTeamHeaders });
            const secondTeamStatePayload = await secondTeamStateResponse.json();

            expect(secondTeamStateResponse.status).toBe(200);
            expect(secondTeamStatePayload.portfolio.teamId).toBe(createTeamPayload.teamContext.teamId);

            const secondTeamBuyResponse = await fetch(`${baseUrl}/api/portfolio/trade`, {
                method: 'POST',
                headers: secondTeamHeaders,
                body: JSON.stringify({ ticker: 'MSFT', type: 'BUY', quantity: 1, price: 300 }),
            });
            expect(secondTeamBuyResponse.status).toBe(200);

            const switchBackResponse = await fetch(`${baseUrl}/api/teams/${registerPayload.user.teamContext.teamId}/switch`, {
                method: 'POST',
                headers: secondTeamHeaders,
                body: JSON.stringify({}),
            });
            const switchBackPayload = await switchBackResponse.json();
            const defaultTeamStateResponse = await fetch(`${baseUrl}/api/portfolio/state`, {
                headers: { Authorization: `Bearer ${switchBackPayload.token}` },
            });
            const defaultTeamStatePayload = await defaultTeamStateResponse.json();

            expect(switchBackResponse.status).toBe(200);
            expect(defaultTeamStatePayload.portfolio.teamId).toBe(registerPayload.user.teamContext.teamId);
            expect(defaultTeamStatePayload.portfolio.positions).toHaveLength(0);

            // Switching to a non-default team must honour the requested team id (switching back to the
            // default team alone cannot tell "requested team" from "fallback to default").
            const switchForwardResponse = await fetch(`${baseUrl}/api/teams/${createTeamPayload.teamContext.teamId}/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${switchBackPayload.token}` },
                body: JSON.stringify({}),
            });
            const switchForwardPayload = await switchForwardResponse.json();
            const secondTeamAgainResponse = await fetch(`${baseUrl}/api/portfolio/state`, {
                headers: { Authorization: `Bearer ${switchForwardPayload.token}` },
            });
            const secondTeamAgainPayload = await secondTeamAgainResponse.json();

            expect(switchForwardResponse.status).toBe(200);
            expect(secondTeamAgainPayload.portfolio.teamId).toBe(createTeamPayload.teamContext.teamId);
            expect(secondTeamAgainPayload.portfolio.positions).toHaveLength(1);
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('allows team admins to manage existing members with backend enforcement', async () => {
        await withTestServer(async (baseUrl) => {
            const ownerRegisterResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'owner@example.com', password: 'password123' }),
            });
            const ownerRegisterPayload = await ownerRegisterResponse.json();

            const memberRegisterResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'member@example.com', password: 'password123' }),
            });
            const memberRegisterPayload = await memberRegisterResponse.json();
            const analystHeaders = { Authorization: `Bearer ${memberRegisterPayload.token}` };

            const { prisma } = await import('../../server/shared/db/db');
            await prisma.user.update({
                where: { id: ownerRegisterPayload.user.id },
                data: { role: 'ADMIN' },
            });
            await prisma.teamMembership.update({
                where: { teamId_userId: { teamId: ownerRegisterPayload.user.teamContext.teamId, userId: ownerRegisterPayload.user.id } },
                data: { role: 'ADMIN' },
            });

            const ownerLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'owner@example.com', password: 'password123' }),
            });
            const ownerLoginPayload = await ownerLoginResponse.json();
            const teamId = ownerLoginPayload.user.teamContext.teamId;
            const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerLoginPayload.token}` };

            expect(ownerLoginPayload.user.teamContext.role).toBe('ADMIN');

            const forbiddenMembersResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members`, { headers: analystHeaders });
            expect(forbiddenMembersResponse.status).toBe(403);

            const membersResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members`, { headers: adminHeaders });
            const membersPayload = await membersResponse.json();
            expect(membersResponse.status).toBe(200);
            expect(membersPayload.members.some((member: { email: string }) => member.email === 'member@example.com')).toBe(true);

            const upsertMemberResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members`, {
                method: 'POST',
                headers: adminHeaders,
                body: JSON.stringify({ email: 'member@example.com', role: 'FUND_MANAGER' }),
            });
            expect(upsertMemberResponse.status).toBe(201);

            const updatedMemberLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'member@example.com', password: 'password123' }),
            });
            const updatedMemberLoginPayload = await updatedMemberLoginResponse.json();
            expect(updatedMemberLoginPayload.user.teamContext.role).toBe('FUND_MANAGER');

            const patchMemberResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members/${memberRegisterPayload.user.id}`, {
                method: 'PATCH',
                headers: adminHeaders,
                body: JSON.stringify({ role: 'COMPLIANCE_OFFICER' }),
            });
            expect(patchMemberResponse.status).toBe(200);

            const removeLastAdminResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members/${ownerRegisterPayload.user.id}`, {
                method: 'DELETE',
                headers: adminHeaders,
            });
            expect(removeLastAdminResponse.status).toBe(409);

            const removeMemberResponse = await fetch(`${baseUrl}/api/teams/${teamId}/members/${memberRegisterPayload.user.id}`, {
                method: 'DELETE',
                headers: adminHeaders,
            });
            expect(removeMemberResponse.status).toBe(200);
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('requires compliance/admin role for restricted-list mutations', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'compliance@example.com', password: 'password123' }),
            });
            const registerPayload = await registerResponse.json();
            const analystHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${registerPayload.token}` };

            const forbiddenResponse = await fetch(`${baseUrl}/api/compliance/restricted`, {
                method: 'POST',
                headers: analystHeaders,
                body: JSON.stringify({ ticker: 'MSFT', name: 'Microsoft', reason: 'Fixture restriction' }),
            });
            const forbiddenPayload = await forbiddenResponse.json();

            expect(forbiddenResponse.status).toBe(403);
            expect(forbiddenPayload.error).toContain('Insufficient role');

            const { prisma } = await import('../../server/shared/db/db');
            await prisma.user.update({
                where: { id: registerPayload.user.id },
                data: { role: 'COMPLIANCE_OFFICER' },
            });
            await prisma.teamMembership.update({
                where: { teamId_userId: { teamId: registerPayload.user.teamContext.teamId, userId: registerPayload.user.id } },
                data: { role: 'COMPLIANCE_OFFICER' },
            });

            const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'compliance@example.com', password: 'password123' }),
            });
            const loginPayload = await loginResponse.json();
            const complianceHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${loginPayload.token}` };

            expect(loginPayload.user.teamContext.role).toBe('COMPLIANCE_OFFICER');

            const allowedResponse = await fetch(`${baseUrl}/api/compliance/restricted`, {
                method: 'POST',
                headers: complianceHeaders,
                body: JSON.stringify({ ticker: 'MSFT', name: 'Microsoft', reason: 'Fixture restriction' }),
            });
            const allowedPayload = await allowedResponse.json();

            expect(allowedResponse.status).toBe(202);
            expect(allowedPayload.success).toBe(true);
            expect(allowedPayload.status).toBe('pending_approval');
            expect(allowedPayload.changeRequest.ticker).toBe('MSFT');
            expect(allowedPayload.summary.pendingApprovals[0].ticker).toBe('MSFT');
            expect(allowedPayload.summary.restricted.some((item: { ticker: string }) => item.ticker === 'MSFT')).toBe(false);
            expect(allowedPayload.provenance.sourceType).toBe('compliance');

            const adminRegisterResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
            });
            const adminRegisterPayload = await adminRegisterResponse.json();
            await prisma.user.update({
                where: { id: adminRegisterPayload.user.id },
                data: { role: 'ADMIN' },
            });
            await prisma.teamMembership.update({
                where: { teamId_userId: { teamId: adminRegisterPayload.user.teamContext.teamId, userId: adminRegisterPayload.user.id } },
                data: { role: 'ADMIN' },
            });
            const adminLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
            });
            const adminLoginPayload = await adminLoginResponse.json();
            const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminLoginPayload.token}` };

            expect(adminLoginPayload.user.teamContext.teamId).toBe(loginPayload.user.teamContext.teamId);
            expect(adminLoginPayload.user.teamContext.role).toBe('ADMIN');

            const selfApproveResponse = await fetch(`${baseUrl}/api/compliance/approvals/${allowedPayload.changeRequest.id}/approve`, {
                method: 'POST',
                headers: complianceHeaders,
                body: JSON.stringify({}),
            });
            expect(selfApproveResponse.status).toBe(403);

            const approveResponse = await fetch(`${baseUrl}/api/compliance/approvals/${allowedPayload.changeRequest.id}/approve`, {
                method: 'POST',
                headers: adminHeaders,
                body: JSON.stringify({}),
            });
            const approvePayload = await approveResponse.json();

            expect(approveResponse.status).toBe(200);
            expect(approvePayload.status).toBe('approved');
            expect(approvePayload.summary.restricted[0].ticker).toBe('MSFT');

            const secondApproveResponse = await fetch(`${baseUrl}/api/compliance/approvals/${allowedPayload.changeRequest.id}/approve`, {
                method: 'POST',
                headers: adminHeaders,
                body: JSON.stringify({}),
            });
            expect(secondApproveResponse.status).toBe(409);

            const removeResponse = await fetch(`${baseUrl}/api/compliance/restricted/MSFT`, {
                method: 'DELETE',
                headers: complianceHeaders,
            });
            const removePayload = await removeResponse.json();

            expect(removeResponse.status).toBe(202);
            expect(removePayload.status).toBe('pending_approval');
            expect(removePayload.changeRequest.action).toBe('REMOVE_RESTRICTED');

            const rejectResponse = await fetch(`${baseUrl}/api/compliance/approvals/${removePayload.changeRequest.id}/reject`, {
                method: 'POST',
                headers: adminHeaders,
                body: JSON.stringify({ note: 'Keep restricted for fixture coverage' }),
            });
            const rejectPayload = await rejectResponse.json();

            expect(rejectResponse.status).toBe(200);
            expect(rejectPayload.status).toBe('rejected');
            expect(rejectPayload.summary.restricted.some((item: { ticker: string }) => item.ticker === 'MSFT')).toBe(true);

            const auditEvents = await prisma.auditEvent.findMany({ where: { category: 'compliance' }, orderBy: { timestamp: 'desc' } });
            expect(auditEvents.some((event) => event.action === 'Approved Compliance Change Request' && event.subject === 'MSFT')).toBe(true);
            expect(auditEvents.some((event) => event.action === 'Rejected Compliance Change Request' && event.subject === 'MSFT')).toBe(true);

            const analystMetricsResponse = await fetch(`${baseUrl}/api/ops/metrics`, { headers: analystHeaders });
            expect(analystMetricsResponse.status).toBe(403);

            const adminMetricsResponse = await fetch(`${baseUrl}/api/ops/metrics`, { headers: adminHeaders });
            const adminMetricsPayload = await adminMetricsResponse.json();
            expect(adminMetricsResponse.status).toBe(200);
            expect(adminMetricsPayload.metrics.requests.total).toBeGreaterThan(0);
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('writes authenticated AI audit events with actor and institutional team context', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'ai-audit@example.com', password: 'password123' }),
            });
            const registerPayload = await registerResponse.json();
            const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${registerPayload.token}` };

            const aiResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ headline: 'AMD expands data center roadmap' }),
            });
            const aiPayload = await aiResponse.json();

            expect(aiResponse.status).toBe(200);
            expect(aiPayload.success).toBe(true);
            expect(aiPayload.modelRunId).toEqual(expect.any(String));

            const { prisma } = await import('../../server/shared/db/db');
            const auditEvent = await prisma.auditEvent.findFirst({
                where: {
                    category: 'ai',
                    action: 'AI Headline Analysis',
                    actorId: registerPayload.user.id,
                },
                orderBy: { timestamp: 'desc' },
            });

            expect(auditEvent).not.toBeNull();
            expect(auditEvent?.actorName).toBe('ai-audit@example.com');
            expect(auditEvent?.teamId).toBe(registerPayload.user.teamContext.teamId);
            expect(auditEvent?.subject).toBe('AMD expands data center roadmap');

            const modelRun = await prisma.modelRun.findUnique({ where: { id: aiPayload.modelRunId } });
            expect(modelRun?.actorId).toBe(registerPayload.user.id);
            expect(modelRun?.teamId).toBe(registerPayload.user.teamContext.teamId);
            expect(modelRun?.route).toBe('/api/ai/analyze');
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('executes portfolio trades atomically and returns updated balances', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'portfolio@example.com', password: 'password123' }),
            });
            const { token } = await registerResponse.json();
            const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

            const stateResponse = await fetch(`${baseUrl}/api/portfolio/state`, { headers: authHeaders });
            const statePayload = await stateResponse.json();
            expect(statePayload.portfolio.cashBalance).toBe(100000);

            const buyResponse = await fetch(`${baseUrl}/api/portfolio/trade`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ ticker: 'aapl', type: 'BUY', quantity: 10, price: 100 }),
            });
            const buyPayload = await buyResponse.json();

            expect(buyResponse.status).toBe(200);
            expect(buyPayload.message).toBe('Paper trade recorded successfully');
            expect(buyPayload.executionMode).toBe('paper');
            expect(buyPayload.portfolio.cashBalance).toBe(99000);
            expect(buyPayload.portfolio.totalBalance).toBe(100000);
            expect(buyPayload.portfolio.positions).toHaveLength(1);
            expect(buyPayload.portfolio.positions[0].ticker).toBe('AAPL');

            const sellResponse = await fetch(`${baseUrl}/api/portfolio/trade`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ ticker: 'AAPL', type: 'SELL', quantity: 5, price: 120 }),
            });
            const sellPayload = await sellResponse.json();

            expect(sellResponse.status).toBe(200);
            expect(sellPayload.portfolio.cashBalance).toBe(99600);
            expect(sellPayload.portfolio.totalBalance).toBe(100200);
            expect(sellPayload.portfolio.positions[0].quantity).toBe(5);
            expect(sellPayload.portfolio.transactions).toHaveLength(2);

            const oversellResponse = await fetch(`${baseUrl}/api/portfolio/trade`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ ticker: 'AAPL', type: 'SELL', quantity: 10, price: 125 }),
            });
            const oversellPayload = await oversellResponse.json();

            expect(oversellResponse.status).toBe(400);
            expect(oversellPayload.error).toBe('Insufficient position quantity');

            const closeResponse = await fetch(`${baseUrl}/api/portfolio/trade`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ ticker: 'AAPL', type: 'SELL', quantity: 5, price: 125 }),
            });
            const closePayload = await closeResponse.json();

            expect(closeResponse.status).toBe(200);
            expect(closePayload.portfolio.positions).toHaveLength(0);
            expect(closePayload.portfolio.cashBalance).toBe(100225);
            expect(closePayload.portfolio.transactions[0].type).toBe('SELL');
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('adopts a legacy portfolio with no team instead of creating a duplicate', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'legacy-portfolio@example.com', password: 'password123' }),
            });
            const registerPayload = await registerResponse.json();
            const { prisma } = await import('../../server/shared/db/db');
            await prisma.portfolioState.create({
                data: {
                    userId: registerPayload.user.id,
                    teamId: null,
                    totalBalance: 125000,
                    cashBalance: 123000,
                    currentVaR: 0,
                },
            });

            const stateResponse = await fetch(`${baseUrl}/api/portfolio/state`, {
                headers: { Authorization: `Bearer ${registerPayload.token}` },
            });
            const statePayload = await stateResponse.json();

            expect(stateResponse.status).toBe(200);
            expect(statePayload.portfolio.cashBalance).toBe(123000);
            expect(statePayload.portfolio.teamId).toBe(registerPayload.user.teamContext.teamId);

            const portfolioCount = await prisma.portfolioState.count({ where: { userId: registerPayload.user.id } });
            expect(portfolioCount).toBe(1);
        });
    }, BACKEND_CONTRACT_TIMEOUT_MS);

    it('returns 401 instead of a foreign-key 500 when the JWT user no longer exists', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'stale@example.com', password: 'password123' }),
            });
            const { token, user } = await registerResponse.json();
            const { prisma } = await import('../../server/shared/db/db');
            await prisma.user.delete({ where: { id: user.id } });

            const stateResponse = await fetch(`${baseUrl}/api/portfolio/state`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const statePayload = await stateResponse.json();

            expect(stateResponse.status).toBe(401);
            expect(statePayload.error).toContain('User no longer exists');
        });
    });

    it('reports PDF export as disabled instead of returning a fake download', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'export@example.com', password: 'password123' }),
            });
            const { token } = await registerResponse.json();

            const exportResponse = await fetch(`${baseUrl}/api/export/generate-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ reportData: { headline: 'Fixture' } }),
            });
            const exportPayload = await exportResponse.json();

            expect(exportResponse.status).toBe(503);
            expect(exportPayload.success).toBe(false);
            expect(exportPayload.reason).toBe('pdf_export_disabled');
            expect(exportPayload.error).toContain('PDF export is disabled');
        });
    });

    it('does not let an admin access export jobs from another active team', async () => {
        await withTestServer(async (baseUrl) => {
            const registerResponse = await registerAndLogin(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'export-admin@example.com', password: 'password123' }),
            });
            const registerPayload = await registerResponse.json();
            const { prisma } = await import('../../server/shared/db/db');
            await prisma.user.update({
                where: { id: registerPayload.user.id },
                data: { role: 'ADMIN' },
            });
            await prisma.teamMembership.update({
                where: { teamId_userId: { teamId: registerPayload.user.teamContext.teamId, userId: registerPayload.user.id } },
                data: { role: 'ADMIN' },
            });

            const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'export-admin@example.com', password: 'password123' }),
            });
            const loginPayload = await loginResponse.json();

            const statusResponse = await fetch(`${baseUrl}/api/export/status/job-other-team`, {
                headers: { Authorization: `Bearer ${loginPayload.token}` },
            });
            const statusPayload = await statusResponse.json();

            expect(statusResponse.status).toBe(403);
            expect(statusPayload.error).toContain('Export job owner or admin required');
        }, {
            beforeImport: () => {
                vi.doMock('../../server/shared/queue/exportQueue', () => ({
                    getExportQueue: vi.fn(() => ({
                        getJob: vi.fn().mockResolvedValue({
                            id: 'job-other-team',
                            data: { userId: 'different-user', teamId: 'different-team' },
                            failedReason: null,
                            returnvalue: null,
                            getState: vi.fn().mockResolvedValue('completed'),
                        }),
                    })),
                    getExportQueueDiagnostics: vi.fn(() => ({
                        mode: 'queued',
                        redisConfigured: true,
                        pdfExportEnabled: true,
                    })),
                    getExportOutputDir: vi.fn(() => 'output/exports'),
                    isExportQueueConfigured: vi.fn(() => true),
                    isSafeExportArtifactPath: vi.fn(() => true),
                }));
            },
        });
    });
});
