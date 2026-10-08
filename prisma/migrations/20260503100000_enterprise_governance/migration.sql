PRAGMA foreign_keys=OFF;

CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'ANALYST',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_User" ("id", "email", "password", "name", "role", "createdAt", "updatedAt")
SELECT
    "id",
    "email",
    "password",
    "name",
    CASE WHEN "role" = 'USER' THEN 'ANALYST' ELSE "role" END,
    "createdAt",
    "updatedAt"
FROM "User";

DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "actorName" TEXT,
    "teamId" TEXT,
    "subject" TEXT,
    "outcome" TEXT NOT NULL,
    "details" TEXT,
    CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ComplianceRestrictedSecurity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restrictedSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restrictedUntil" DATETIME,
    "addedById" TEXT,
    "addedByName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComplianceRestrictedSecurity_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ComplianceAlertRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComplianceAlertRecord_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ComplianceChangeRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "reason" TEXT,
    "restrictedUntil" DATETIME,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    CONSTRAINT "ComplianceChangeRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComplianceChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ComplianceChangeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "new_PortfolioState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "teamId" TEXT,
    "totalBalance" REAL NOT NULL DEFAULT 0,
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "currentVaR" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PortfolioState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PortfolioState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_PortfolioState" ("id", "userId", "teamId", "totalBalance", "cashBalance", "currentVaR", "updatedAt")
SELECT "id", "userId", NULL, "totalBalance", "cashBalance", "currentVaR", "updatedAt"
FROM "PortfolioState";

DROP TABLE "PortfolioState";
ALTER TABLE "new_PortfolioState" RENAME TO "PortfolioState";

CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");
CREATE UNIQUE INDEX "TeamMembership_teamId_userId_key" ON "TeamMembership"("teamId", "userId");
CREATE INDEX "TeamMembership_userId_idx" ON "TeamMembership"("userId");
CREATE INDEX "PortfolioState_userId_idx" ON "PortfolioState"("userId");
CREATE UNIQUE INDEX "PortfolioState_userId_key" ON "PortfolioState"("userId");
CREATE INDEX "PortfolioState_teamId_idx" ON "PortfolioState"("teamId");
CREATE INDEX "AuditEvent_timestamp_idx" ON "AuditEvent"("timestamp");
CREATE INDEX "AuditEvent_category_idx" ON "AuditEvent"("category");
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");
CREATE INDEX "AuditEvent_teamId_idx" ON "AuditEvent"("teamId");
CREATE UNIQUE INDEX "ComplianceRestrictedSecurity_teamId_ticker_key" ON "ComplianceRestrictedSecurity"("teamId", "ticker");
CREATE INDEX "ComplianceRestrictedSecurity_teamId_active_idx" ON "ComplianceRestrictedSecurity"("teamId", "active");
CREATE INDEX "ComplianceAlertRecord_teamId_resolved_idx" ON "ComplianceAlertRecord"("teamId", "resolved");
CREATE INDEX "ComplianceChangeRequest_teamId_status_idx" ON "ComplianceChangeRequest"("teamId", "status");
CREATE INDEX "ComplianceChangeRequest_requestedById_idx" ON "ComplianceChangeRequest"("requestedById");
CREATE INDEX "ComplianceChangeRequest_reviewedById_idx" ON "ComplianceChangeRequest"("reviewedById");

PRAGMA foreign_keys=ON;
