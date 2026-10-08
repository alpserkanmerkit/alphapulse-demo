-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NewsArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "headline" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" REAL,
    "isAnalyzed" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    CONSTRAINT "NewsArchive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DebateHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "newsId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "bullProbability" INTEGER NOT NULL,
    "bearProbability" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    CONSTRAINT "DebateHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "totalBalance" REAL NOT NULL DEFAULT 0,
    "cashBalance" REAL NOT NULL DEFAULT 0,
    "currentVaR" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PortfolioState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolioStateId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "averagePrice" REAL NOT NULL,
    "currentPrice" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Position_portfolioStateId_fkey" FOREIGN KEY ("portfolioStateId") REFERENCES "PortfolioState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolioStateId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "price" REAL NOT NULL,
    "commission" REAL NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_portfolioStateId_fkey" FOREIGN KEY ("portfolioStateId") REFERENCES "PortfolioState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "NewsArchive_userId_idx" ON "NewsArchive"("userId");

-- CreateIndex
CREATE INDEX "DebateHistory_userId_idx" ON "DebateHistory"("userId");

-- CreateIndex
CREATE INDEX "PortfolioState_userId_idx" ON "PortfolioState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioState_userId_key" ON "PortfolioState"("userId");

-- CreateIndex
CREATE INDEX "Position_portfolioStateId_idx" ON "Position"("portfolioStateId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_portfolioStateId_ticker_key" ON "Position"("portfolioStateId", "ticker");

-- CreateIndex
CREATE INDEX "Transaction_portfolioStateId_idx" ON "Transaction"("portfolioStateId");
