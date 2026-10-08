// =============================================
// CORE ENUMS
// =============================================

export enum Category {
  ALL = 'ALL',
  CRYPTO = 'CRYPTO',
  STOCKS = 'STOCKS',
  FOREX = 'FOREX',
  COMMODITIES = 'COMMODITIES',
  STARTUP = 'STARTUP',
  MACRO = 'MACRO'
}

export enum UserTier {
  FREE = 'FREE',
  PRO = 'PRO',
  INSTITUTIONAL = 'INSTITUTIONAL'
}

export enum Sentiment {
  POSITIVE = 'POSITIVE',
  NEGATIVE = 'NEGATIVE',
  NEUTRAL = 'NEUTRAL'
}

export type DataMode = 'live' | 'simulation' | 'fallback';
export type RuntimeMode = 'live' | 'simulation';
export type QuantServiceStatus = 'reachable' | 'unreachable';
export type QuantDiagnosticReason = 'connection_refused' | 'timeout' | 'http_error' | 'invalid_payload' | 'unknown';
export type ComplianceServiceStatus = 'ready' | 'degraded' | 'unavailable';
export type ComplianceDatasetSource = 'local-file';
export type ComplianceDiagnosticReason = 'dataset_missing' | 'invalid_dataset' | 'read_error' | 'unknown';
export type AiFailureStage = 'compliance' | 'quant' | 'grounding' | 'model' | 'route' | 'unknown';
export type TradeDirection = 'LONG' | 'SHORT' | 'HEDGE' | 'WAIT';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type UserRole = 'FUND_MANAGER' | 'ANALYST' | 'COMPLIANCE_OFFICER' | 'ADMIN';
export type ProvenanceSourceType = 'market_data' | 'news' | 'ai' | 'quant' | 'portfolio' | 'compliance' | 'system';
export type DataQualityStatus = 'ready' | 'degraded' | 'empty' | 'unavailable';

export interface Provenance {
  provider: string;
  fetchedAt: string;
  mode: DataMode;
  sourceType: ProvenanceSourceType;
  fromCache: boolean;
  degradationReason: string | null;
}

export interface DataQuality {
  status: DataQualityStatus;
  freshness: string | null;
  observations: number;
  missingSymbols: string[];
  errors: Record<string, string>;
}

export interface Telemetry {
  requestId?: string | null;
  durationMs?: number;
  failureStage?: AiFailureStage | string | null;
}

export interface InstitutionalEnvelope<T> {
  success: boolean;
  data: T;
  provenance: Provenance;
  dataQuality: DataQuality;
  telemetry?: Telemetry;
}

// =============================================
// USER & AUTH
// =============================================

export interface UserProfile {
  id: string;
  name: string;
  tier: UserTier;
  role: UserRole;
  department?: string;
  restrictedList?: string[];
  preferences?: UserPreferences;
}

export interface UserPreferences {
  alertMinScore: number;
  silentHoursStart?: string;
  silentHoursEnd?: string;
  defaultPortfolioId?: string;
  layoutPreset?: string;
}

// =============================================
// NEWS & ANALYSIS (EXISTING - EXPANDED)
// =============================================

export interface TradingScenario {
  direction: TradeDirection;
  asset: string;
  rationale: string;
  risk: RiskLevel;
}

export interface DeepDiveResponse {
  content: string;
  scenarios: TradingScenario[];
}

export interface MarketEvent {
  id: string;
  headline: string;
  relatedNewsIds: string[];
  timestamp: number;
}

export interface NewsItem {
  id: string;
  headline: string;
  timestamp: number;
  category: Category;
  source: string;
  sourceReliability?: number;
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  relatedTickers?: string[];
  eventId?: string;
  // Analysis fields (populated by AI)
  score?: number;
  scoreRationale?: string;
  sentiment?: Sentiment;
  summary?: string;
  affectedAssets?: string[];
  analysisMode?: DataMode;
  analysisNotice?: string;
  analysisError?: string;
  analysisQueued?: boolean;
  isAnalyzed: boolean;
  isAnalysing: boolean;
  // Deep Dive Module
  deepDive?: DeepDiveResponse;
  deepDiveMode?: DataMode;
  deepDiveNotice?: string;
  isDeepDiveLoading?: boolean;
  groundingSources?: { title: string; uri: string }[];
  groundingUsed?: boolean;
  // Institutional Modules
  portfolioImpact?: PortfolioImpact;
  rippleEffects?: RippleEffect;
  altDataSignals?: AltDataSignal[];
  debateResult?: DebateResult;
}

export interface MarketStat {
  label: string;
  value: string;
  change: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

// =============================================
// PORTFOLIO & HOLDINGS
// =============================================

export interface Portfolio {
  id: string;
  name: string;
  holdings: Holding[];
  totalAUM: number;
  currency: string;
  benchmarkIndex: string;
  createdAt: number;
}

export interface Holding {
  id: string;
  asset: string;
  ticker: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  weight: number;
  sector: string;
  region: string;
  assetClass: 'EQUITY' | 'FIXED_INCOME' | 'COMMODITY' | 'CRYPTO' | 'FOREX' | 'DERIVATIVE';
}

export interface PortfolioImpact {
  newsId: string;
  portfolioId: string;
  affectedHoldings: AffectedHolding[];
  estimatedPnL: number;
  estimatedPnLPercent: number;
  varDelta: number;
  severity: 'NEGLIGIBLE' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
}

export interface AffectedHolding {
  holdingId: string;
  ticker: string;
  currentWeight: number;
  estimatedImpact: number;
  impactDirection: 'POSITIVE' | 'NEGATIVE';
  confidence: number;
}

// =============================================
// RISK ENGINE
// =============================================

export interface VaRResult {
  method: 'HISTORICAL' | 'PARAMETRIC' | 'MONTE_CARLO';
  confidence: number;
  horizon: number;
  value: number;
  valuePercent: number;
  breakdown: VaRBreakdown[];
}

export interface VaRBreakdown {
  sector: string;
  contribution: number;
  weight: number;
}

export interface StressTestScenario {
  id: string;
  name: string;
  description: string;
  shockParams: Record<string, number>;
  portfolioImpact: number;
  portfolioImpactPercent: number;
  varAfter: number;
}

// =============================================
// MULTI-AGENT SYSTEM (WAR ROOM)
// =============================================

export type { AgentPersona } from './shared/agentPersonas';

export interface AgentArgument {
  agentId: string;
  agentName: string;
  position: TradeDirection;
  confidence: number;
  reasoning: string;
  evidence: string[];
  scenarios: TradingScenario[];
  timestamp: number;
}

export interface DebateResult {
  newsId: string;
  arguments: AgentArgument[];
  consensus: ConsensusResult;
  uncertainty: 'LOW' | 'MEDIUM' | 'HIGH';
  timestamp: number;
}

export interface ConsensusResult {
  direction: TradeDirection;
  confidence: number;
  bullishProbability: number;
  bearishProbability: number;
  neutralProbability: number;
  summary: string;
}

// =============================================
// KNOWLEDGE GRAPH & RIPPLE EFFECT
// =============================================

export type EntityType = 'COMPANY' | 'SECTOR' | 'COUNTRY' | 'COMMODITY' | 'CURRENCY' | 'INDEX';
export type EdgeType = 'SUPPLIES_TO' | 'COMPETES_WITH' | 'DEPENDS_ON' | 'CORRELATED_WITH' | 'SUBSIDIARY_OF';

export interface EntityNode {
  id: string;
  name: string;
  ticker?: string;
  type: EntityType;
  sector?: string;
  region?: string;
  marketCap?: number;
}

export interface SupplyChainEdge {
  from: string;
  to: string;
  relationship: EdgeType;
  strength: number;
  latencyDays?: number;
}

export interface RippleEffect {
  sourceEvent: string;
  sourceEntity: string;
  hops: RippleHop[];
  totalAffectedEntities: number;
}

export interface RippleHop {
  depth: number;
  entities: RippleEntity[];
}

export interface RippleEntity {
  entityId: string;
  entityName: string;
  ticker?: string;
  impactDirection: 'POSITIVE' | 'NEGATIVE';
  impactMagnitude: number;
  relationship: EdgeType;
  pathDescription: string;
}

// =============================================
// ALT-DATA
// =============================================

export type AltDataSource = 'SATELLITE' | 'SHIPPING' | 'CREDIT_CARD' | 'SOCIAL' | 'WEATHER';

export interface AltDataSignal {
  id: string;
  type: AltDataSource;
  source: string;
  timestamp: number;
  rawValue: number;
  interpretation: string;
  confidence: number;
  agreesWithNews: boolean;
}

export interface CrossValidationResult {
  newsId: string;
  overallAgreement: number;
  signals: AltDataSignal[];
  conflicts: AltDataConflict[];
}

export interface AltDataConflict {
  signalId: string;
  newsAssertion: string;
  altDataEvidence: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
}

// =============================================
// HEDGE ENGINE
// =============================================

export type HedgeType = 'PUT_BUY' | 'COLLAR' | 'PAIR_TRADE' | 'CURRENCY_HEDGE' | 'VIX_CALL' | 'INVERSE_ETF';

export interface HedgeStrategy {
  id: string;
  type: HedgeType;
  instruments: HedgeInstrument[];
  totalCost: number;
  totalCostPercent: number;
  protectionLevel: number;
  maxLoss: number;
  expiry?: number;
  breakEvenPoint?: number;
}

export interface HedgeInstrument {
  name: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  price: number;
}

export interface HedgeRecommendation {
  newsId: string;
  portfolioId: string;
  currentRisk: number;
  strategies: HedgeStrategy[];
  bestStrategy: HedgeStrategy;
  reasoning: string;
}

// =============================================
// COMPLIANCE & AUDIT
// =============================================

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  category: 'NEWS_VIEW' | 'TRADE_ACTION' | 'HEDGE_EXECUTION' | 'PORTFOLIO_CHANGE' | 'SYSTEM';
  timestamp: number;
  details: string;
  ipAddress?: string;
  relatedNewsId?: string;
}

export interface RestrictedSecurity {
  ticker: string;
  name: string;
  reason: string;
  restrictedSince: number;
  restrictedUntil?: number;
  addedBy: string;
}

export interface ComplianceAlert {
  id: string;
  type: 'RESTRICTED_MATCH' | 'VAR_BREACH' | 'CONCENTRATION_RISK' | 'UNAUTHORIZED_ACCESS';
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  timestamp: number;
  resolved: boolean;
}

export interface ComplianceChangeRequestSummary {
  id: string;
  action: 'ADD_RESTRICTED' | 'REMOVE_RESTRICTED';
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  ticker: string;
  name?: string;
  reason?: string;
  restrictedUntil?: number;
  requestedById: string;
  requestedByName: string;
  requestedByRole: string;
  reviewedById?: string | null;
  reviewedByName?: string | null;
  reviewNote?: string | null;
  createdAt: number;
  reviewedAt?: number | null;
}

export interface RuntimeServicesStatus {
  ai: RuntimeMode;
  quant: QuantServiceStatus;
  compliance: ComplianceServiceStatus;
}

export interface QuantDiagnostics {
  reason: QuantDiagnosticReason | null;
  checkedAt: string;
}

export interface ComplianceDiagnostics {
  source: ComplianceDatasetSource | null;
  reason: ComplianceDiagnosticReason | null;
  loadedAt: string | null;
}

export interface RuntimeDiagnostics {
  quant: QuantDiagnostics;
  compliance: ComplianceDiagnostics;
}

export interface RuntimeStatusResponse {
  status: 'ok';
  version: string;
  mode: RuntimeMode;
  services: RuntimeServicesStatus;
  diagnostics: RuntimeDiagnostics;
  timestamp: string;
}

export interface ComplianceSummaryResponse {
  version: number;
  hash: string;
  updatedAt: string;
  alerts: ComplianceAlert[];
  restricted: RestrictedSecurity[];
  audit: AuditEntry[];
  pendingApprovals?: ComplianceChangeRequestSummary[];
}

export interface ComplianceCheckResult {
  ticker: string;
  restricted: boolean;
  security: RestrictedSecurity | null;
}

export interface TeamContext {
  teamId: string;
  teamName: string;
  role: UserRole;
}

export interface ModelRunSummary {
  id: string;
  teamId?: string | null;
  actorId?: string | null;
  route: string;
  modelFamily: string;
  modelName?: string | null;
  promptVersion?: string | null;
  inputHash: string;
  mode: DataMode | string;
  outcome: 'success' | 'failure' | 'fallback' | 'cache_hit' | string;
  failureStage?: string | null;
  durationMs?: number | null;
  sourceCount: number;
  createdAt: string;
}

export interface PortfolioRiskResponse {
  range: '3M' | '6M' | '12M' | '24M';
  confidence: number;
  horizonDays: number;
  generatedAt: string;
  equity: number;
  marketValue: number;
  metrics: null | {
    historicalVaR: number;
    historicalVaRPercent: number;
    parametricVaR: number;
    parametricVaRPercent: number;
    monteCarloVaR: number;
    monteCarloVaRPercent: number;
    expectedShortfall: number;
    expectedShortfallPercent: number;
    annualizedVolatility: number;
  };
  concentration: Array<{ ticker: string; weight: number; marketValue: number; assetClass: string }>;
  factorExposure: Record<string, number>;
  scenarios: Array<{ id: string; name: string; portfolioImpact: number; portfolioImpactPercent: number; varAfter: number }>;
  correlationMatrix: Array<{ symbol: string; correlations: Record<string, number> }>;
  dataQuality: { observations: number; missingSymbols: string[]; status: string };
}

export interface RuntimeCapabilityLabels {
  backend: string;
  ai: string;
  feed: string;
  quant: string;
  compliance: string;
}

export interface RuntimeViewState {
  backendLive: boolean;
  aiMode: DataMode;
  quantStatus: QuantServiceStatus;
  quantReason: QuantDiagnosticReason | null;
  complianceStatus: ComplianceServiceStatus;
  complianceSource: ComplianceDatasetSource | null;
  feedMode: DataMode;
  analysisMode: DataMode;
  notices: string[];
  diagnostics: string[];
  labels: RuntimeCapabilityLabels;
}

export interface AiRouteTelemetry {
  durationMs?: number;
  failureStage?: AiFailureStage | null;
}

// =============================================
// REGULATORY
// =============================================

export interface RegulatoryFiling {
  id: string;
  authority: string;
  title: string;
  publishDate: number;
  pages: number;
  summary: string;
  fullTextUrl?: string;
}

export interface RegulatoryImpact {
  filingId: string;
  affectedSectors: string[];
  opportunities: RegulatoryOpportunity[];
  risks: string[];
  alphaScore: number;
}

export interface RegulatoryOpportunity {
  description: string;
  affectedTickers: string[];
  estimatedImpact: 'LOW' | 'MEDIUM' | 'HIGH';
  timeframe: string;
}

// =============================================
// NOTIFICATIONS
// =============================================

export interface AppNotification {
  id: string;
  type: 'NEWS_ALERT' | 'PORTFOLIO_IMPACT' | 'COMPLIANCE' | 'WAR_ROOM' | 'SYSTEM';
  title: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  timestamp: number;
  read: boolean;
  actionUrl?: string;
  relatedNewsId?: string;
}

// =============================================
// NAVIGATION & LAYOUT
// =============================================

export type AppView = 'dashboard' | 'portfolio' | 'war-room' | 'ripple' | 'compliance' | 'settings';

export interface LayoutPanel {
  id: string;
  component: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isVisible: boolean;
}

export interface LayoutPreset {
  id: string;
  name: string;
  panels: LayoutPanel[];
}
