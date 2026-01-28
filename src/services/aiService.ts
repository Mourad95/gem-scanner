/**
 * Service d'analyse sémantique de tokens via Ollama (IA locale)
 * @module services/aiService
 */

import axios from 'axios';

/**
 * Configuration de l'API Ollama
 * L'URL peut être configurée via la variable d'environnement OLLAMA_API_URL
 * Par défaut: http://127.0.0.1:11434/api/generate (pour développement local)
 * En Docker: http://ollama:11434/api/generate (via docker-compose)
 */
const OLLAMA_API_URL = process.env['OLLAMA_API_URL'] || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:0.5b';
const OLLAMA_TIMEOUT = 3000; // 3 secondes - timeout pour permettre au modèle de répondre
const OLLAMA_SENTIMENT_TIMEOUT = 3000; // 3 secondes - timeout optimisé pour le sniping
const OLLAMA_TEMPERATURE = 0.1; // Pour des réponses déterministes et rapides

/**
 * Prompt système pour l'analyse sémantique complète
 */
const SYSTEM_PROMPT = `You are a crypto meme coin analyst. Analyze the metadata. Detect narrative (Dog, Cat, PolitiFi, AI, etc.) and risk. Output JSON: { narrative: string, sentimentScore: number (0-100), isLowEffort: boolean, riskLabel: string }`;

/**
 * Prompt système pour l'analyse de sentiment rapide (sniping) - Ultra-concis
 */
const SENTIMENT_SYSTEM_PROMPT = `Rate token name 0-100. 0=Offensive/Spam. 100=Viral/Meme/Trends. Return number only.`;

/**
 * Résultat de l'analyse sémantique d'un token
 */
export interface SemanticAnalysisResult {
  narrative: string;
  sentimentScore: number; // 0-100
  isLowEffort: boolean;
  riskLabel: string;
}

/**
 * Valeur par défaut retournée en cas d'erreur ou de timeout
 */
const DEFAULT_RESULT: SemanticAnalysisResult = {
  narrative: 'Unknown',
  sentimentScore: 50, // Score neutre pour ne pas bloquer le scanner
  isLowEffort: false,
  riskLabel: 'Neutral',
};

/**
 * Analyse sémantiquement un token Solana via Ollama
 * Détecte les narratifs viraux et les arnaques textuelles (descriptions génériques ChatGPT)
 * 
 * @param {string} name - Nom du token
 * @param {string} symbol - Symbole du token
 * @param {string} description - Description du token (sera tronquée à 200 caractères)
 * @returns {Promise<SemanticAnalysisResult>} Résultat de l'analyse sémantique
 */
export async function analyzeTokenSemantics(
  name: string = '',
  symbol: string = '',
  description: string = ''
): Promise<SemanticAnalysisResult> {
  // Tronquer la description à 200 caractères pour optimiser la vitesse
  const truncatedDescription = description ? description.substring(0, 200) : '';

  // Construire le prompt utilisateur
  const userPrompt = `Analyze this token metadata:
Name: ${name || 'N/A'}
Symbol: ${symbol || 'N/A'}
Description: ${truncatedDescription || 'N/A'}`;

  try {
    const response = await axios.post<{ response: string }>(
      OLLAMA_API_URL,
      {
        model: OLLAMA_MODEL,
        prompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`,
        format: 'json', // Critical pour le parsing
        stream: false,
        options: {
          temperature: OLLAMA_TEMPERATURE,
        },
      },
      {
        timeout: OLLAMA_TIMEOUT, // Timeout de 3000ms
      }
    );

    // Parser la réponse JSON
    const responseText = response.data.response;
    if (!responseText) {
      return DEFAULT_RESULT;
    }

    try {
      const parsed = JSON.parse(responseText) as SemanticAnalysisResult;

      // Valider la structure de la réponse
      if (
        typeof parsed.narrative === 'string' &&
        typeof parsed.sentimentScore === 'number' &&
        typeof parsed.isLowEffort === 'boolean' &&
        typeof parsed.riskLabel === 'string'
      ) {
        // S'assurer que sentimentScore est dans la plage 0-100
        parsed.sentimentScore = Math.max(0, Math.min(100, parsed.sentimentScore));
        return parsed;
      }

      // Si la structure est invalide, retourner la valeur par défaut
      return DEFAULT_RESULT;
    } catch (parseError) {
      // Si Ollama hallucine le format JSON, retourner la valeur par défaut
      console.warn('[AI Service] Erreur de parsing JSON:', parseError);
      return DEFAULT_RESULT;
    }
  } catch (error) {
    // Gérer les erreurs (timeout, réseau, etc.) en retournant une valeur par défaut
    // Ne jamais bloquer le scanner
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        console.warn('[AI Service] Timeout Ollama (>3000ms) - utilisation de la valeur par défaut');
      } else {
        console.warn('[AI Service] Erreur Ollama:', error.message);
      }
    } else {
      console.warn('[AI Service] Erreur inconnue:', error);
    }

    return DEFAULT_RESULT;
  }
}

/**
 * Analyse le potentiel viral d'un token via Ollama (version rapide pour sniping)
 * Retourne un score de 0 à 100 basé uniquement sur le nom et le symbole
 * 
 * @param {string} name - Nom du token
 * @param {string} symbol - Symbole du token
 * @returns {Promise<number>} Score de sentiment entre 0 et 100 (50 par défaut en cas d'erreur)
 */
export async function analyzeTokenSentiment(
  name: string = '',
  symbol: string = ''
): Promise<number> {
  const userPrompt = `Token Name: "${name}", Symbol: "${symbol}". Rate it.`;

  // Créer un AbortController pour gérer le timeout strict
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, OLLAMA_SENTIMENT_TIMEOUT);

  // Log de performance
  console.time('AI');

  try {
    const response = await axios.post<{ response: string }>(
      OLLAMA_API_URL,
      {
        model: OLLAMA_MODEL,
        system: SENTIMENT_SYSTEM_PROMPT,
        prompt: userPrompt,
        stream: false,
        keep_alive: -1, // Force le maintien du modèle en mémoire (évite les timeouts au redémarrage)
        options: {
          temperature: OLLAMA_TEMPERATURE,
          num_predict: 10, // Force une réponse très courte (juste le chiffre)
        },
      },
      {
        timeout: OLLAMA_SENTIMENT_TIMEOUT, // 3 secondes - bon compromis
        signal: abortController.signal,
      }
    );

    clearTimeout(timeoutId);
    console.timeEnd('AI');

    // Extraire le score de la réponse
    const rawResponse = response.data?.response;
    if (!rawResponse || typeof rawResponse !== 'string') {
      return 50; // Score neutre
    }
    
    const responseText = rawResponse.trim();
    if (!responseText) {
      return 50; // Score neutre
    }

    // Parser la réponse pour extraire uniquement le nombre avec regex /\d+/
    const numberMatch = responseText.match(/\d+/);
    if (numberMatch && numberMatch[0]) {
      const score = parseInt(numberMatch[0], 10);
      // S'assurer que le score est dans la plage 0-100
      if (!isNaN(score)) {
        return Math.max(0, Math.min(100, score));
      }
    }

    // Si aucun nombre trouvé, retourner un score neutre
    return 50;
  } catch (error) {
    clearTimeout(timeoutId);
    console.timeEnd('AI'); // Fermer le timer en cas d'erreur

    // Gérer les erreurs (timeout, réseau, etc.) en retournant un score neutre
    // Ne jamais bloquer le scanner - logs discrets
    if (axios.isAxiosError(error)) {
      // Détecter les timeouts et les annulations (canceled)
      const isTimeout = 
        error.code === 'ECONNABORTED' || 
        error.name === 'AbortError' ||
        error.message?.toLowerCase().includes('canceled') ||
        error.message?.toLowerCase().includes('timeout');
      
      if (isTimeout) {
        // Timeout ou annulation - log clair
        console.timeEnd('AI'); // Fermer le timer même en cas de timeout
        console.warn('⚠️ [AI] Timeout (3s) - Modèle trop lent');
        return 50;
      }
      // Autres erreurs réseau - log discret
      console.warn('[AI Service] Erreur Ollama sentiment:', error.message);
      return 50;
    }

    // Erreur inconnue - log discret
    console.warn('[AI Service] Erreur inconnue sentiment:', error);
    return 50;
  }
}

