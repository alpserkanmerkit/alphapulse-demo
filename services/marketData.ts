import { Category, NewsItem } from "../types";
import { v4 as uuidv4 } from 'uuid';

const MOCK_HEADLINES = [
  { text: "Federal Reserve hints at expedited rate cuts following weak jobs report.", cat: Category.MACRO, src: "Bloomberg" },
  { text: "Bitcoin breaks $100k barrier as institutional inflow surges to record highs.", cat: Category.CRYPTO, src: "CoinDesk" },
  { text: "Tesla unveils fully autonomous Optimus bot, stock jumps 12% pre-market.", cat: Category.STOCKS, src: "Reuters" },
  { text: "Gold plummets as geopolitical tensions in Middle East de-escalate unexpectedly.", cat: Category.COMMODITIES, src: "Kitco" },
  { text: "European Central Bank holds rates steady, emphasizes inflation concerns.", cat: Category.FOREX, src: "Financial Times" },
  { text: "OpenAI announces 'GPT-5' with reasoning capabilities exceeding human experts.", cat: Category.STARTUP, src: "TechCrunch" },
  { text: "Oil prices surge as OPEC+ announces surprise supply cuts.", cat: Category.COMMODITIES, src: "Bloomberg" },
  { text: "SEC approves Ethereum Spot ETF, trading to begin next Tuesday.", cat: Category.CRYPTO, src: "CNBC" },
  { text: "Apple reports lower than expected iPhone sales in China.", cat: Category.STOCKS, src: "WSJ" },
  { text: "SpaceX Starship successfully reaches orbit and returns.", cat: Category.STARTUP, src: "X News" }
];

export const generateNewsItem = (): NewsItem => {
  const random = MOCK_HEADLINES[Math.floor(Math.random() * MOCK_HEADLINES.length)];
  
  return {
    id: uuidv4(),
    headline: random.text,
    timestamp: Date.now(),
    category: random.cat,
    source: random.src,
    isAnalyzed: false,
    isAnalysing: false
  };
};