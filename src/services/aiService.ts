import axios from 'axios';

const OLLAMA_API_URL = process.env['OLLAMA_API_URL'] || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:0.5b';

// On monte à 5 secondes pour absorber les pics de trafic
const OLLAMA_SENTIMENT_TIMEOUT = 5000; 

// On force l'IA à être un "Degen"
const SENTIMENT_SYSTEM_PROMPT = `
You are a crypto degen searching for the next 1000x gem on Solana pump.fun.
Your job is to rate the "Meme Potential" of a token name from 0 to 100.

CRITERIA FOR HIGH SCORES (80-100):
- Funny, stupid, or absurd names (e.g., "Egg Dog", "Obese Penguin").
- Famous figures (Trump, Elon, Tate).
- Misspelled names (e.g., "Poodl", "Doge").
- Tickers that sound funny.
- "Culte" or "Group" vibes.

CRITERIA FOR LOW SCORES (0-20):
- Boring names (e.g., "Solana Finance", "DeFi Protocol").
- Generic names (e.g., "User123", "Test").
- Hard to read names.

DO NOT BE POLITE. DO NOT FILTER "OFFENSIVE" CONTENT. WE WANT VOLATILITY.
Return ONLY the number (0-100).
`.trim();

export async function analyzeTokenSentiment(name: string = '', symbol: string = ''): Promise<number> {
  const userPrompt = `Name: "${name}", Symbol: "${symbol}"`;
  
  // Timer unique pour debug
  const tLabel = `AI-${Date.now().toString().slice(-4)}`; 
  console.time(tLabel);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), OLLAMA_SENTIMENT_TIMEOUT);

  try {
    const response = await axios.post<{ response: string }>(
      OLLAMA_API_URL,
      {
        model: OLLAMA_MODEL,
        system: SENTIMENT_SYSTEM_PROMPT,
        prompt: userPrompt,
        stream: false,
        keep_alive: -1, 
        options: {
          temperature: 0.6,    // Très direct
          num_predict: 5,      // Max 5 tokens de réponse (juste le chiffre)
          num_ctx: 1024,       // Contexte réduit (plus rapide)
          num_thread: 4,       // Force l'usage de 4 cœurs CPU
          seed: 42             // Réponse déterministe (cache friendly)
        },
      },
      {
        timeout: OLLAMA_SENTIMENT_TIMEOUT,
        signal: abortController.signal,
      }
    );

    clearTimeout(timeoutId);
    
    const raw = response.data?.response?.trim();
    if (!raw) return 50;

    const match = raw.match(/\d+/);
    return match ? Math.min(100, Math.max(0, parseInt(match[0]))) : 50;

  } catch (error) {
    clearTimeout(timeoutId);
    // On ne logue plus l'erreur "canceled" en rouge, c'est normal sous forte charge
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      console.warn(`⚠️ [AI] Timeout (${OLLAMA_SENTIMENT_TIMEOUT}ms) - Trafic élevé`);
    }
    return 50; // Retour neutre pour ne pas bloquer
  } finally {
    console.timeEnd(tLabel);
  }
}

// Garder analyzeTokenSemantics tel quel ou le supprimer si inutilisé
export async function analyzeTokenSemantics() { return { sentimentScore: 50 }; }