/**
 * Service d'analyse sémantique de tokens via Ollama (IA locale)
 * @module services/aiService
 */

import axios from 'axios';

/**
 * Configuration de l'API Ollama
 * L'URL peut être configurée via la variable d'environnement OLLAMA_API_URL
 * Par défaut: http://localhost:11434/api/generate (pour développement local)
 * En Docker: http://ollama:11434/api/generate (via docker-compose)
 */
const OLLAMA_API_URL = process.env['OLLAMA_API_URL'] || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:0.5b';
const OLLAMA_TIMEOUT = 3000; // 3 secondes - timeout pour permettre au modèle de répondre
const OLLAMA_TEMPERATURE = 0.1; // Pour des réponses déterministes et rapides

/**
 * Prompt système pour l'analyse sémantique
 */
const SYSTEM_PROMPT = `You are a crypto meme coin analyst. Analyze the metadata. Detect narrative (Dog, Cat, PolitiFi, AI, etc.) and risk. Output JSON: { narrative: string, sentimentScore: number (0-100), isLowEffort: boolean, riskLabel: string }`;

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

