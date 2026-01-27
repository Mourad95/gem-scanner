/**
 * Rate Limiter Global pour les appels RPC Solana
 * Évite les erreurs 429 (Too Many Requests) avec gestion intelligente
 * @module services/rateLimiter
 */

/**
 * Rate Limiter basé sur un Token Bucket avec gestion intelligente des 429
 * Implémente une pause globale en cas d'erreur 429 pour éviter le spam
 * Utilise un Jitter pour éviter que toutes les requêtes réessaient en même temps
 */
export class RpcRateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens par seconde
  private lastRefill: number;
  private maxConcurrent: number;
  private currentConcurrent: number = 0;
  private isPaused: boolean = false;
  private pauseUntil: number = 0;
  private readonly BASE_BACKOFF = 2000; // Délai de base du backoff : 2000ms (augmenté de 500ms)
  private readonly JITTER_MAX = 1000; // Jitter maximum : 1000ms (délai aléatoire pour éviter les synchronisations)

  /**
   * @param {number} maxRequestsPerSecond - Nombre maximum de requêtes par seconde (défaut: 10)
   * @param {number} maxConcurrent - Nombre maximum de requêtes parallèles (défaut: 5)
   */
  constructor(maxRequestsPerSecond: number = 10, maxConcurrent: number = 5) {
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond;
    this.lastRefill = Date.now();
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Génère un délai aléatoire (Jitter) pour éviter que toutes les requêtes réessaient en même temps
   * @returns {number} Délai aléatoire en millisecondes (0 à JITTER_MAX)
   */
  private getJitter(): number {
    return Math.floor(Math.random() * this.JITTER_MAX);
  }

  /**
   * Attend qu'un token soit disponible et qu'une slot parallèle soit libre
   */
  private async waitForToken(): Promise<void> {
    const now = Date.now();

    // Vérifier si on est en pause (après un 429)
    if (this.isPaused && now < this.pauseUntil) {
      const waitTime = this.pauseUntil - now;
      
      // SILENCE : Pas de log pendant l'attente (trop verbeux)
      // On log uniquement si le retry échoue définitivement (géré ailleurs)
      
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.isPaused = false; // Reprendre après la pause
    }

    // Attendre qu'une slot parallèle soit disponible
    while (this.currentConcurrent >= this.maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Réapprovisionner les tokens
    const elapsed = (now - this.lastRefill) / 1000; // en secondes
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;

    // Si on a des tokens, on peut continuer
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.currentConcurrent++;
      return;
    }

    // Sinon, attendre qu'un token soit disponible (avec jitter pour éviter les synchronisations)
    const waitTime = (1 - this.tokens) / this.refillRate * 1000;
    const jitter = this.getJitter();
    await new Promise(resolve => setTimeout(resolve, Math.ceil(waitTime) + jitter));
    this.tokens = 0;
    this.lastRefill = Date.now();
    this.currentConcurrent++;
  }

  /**
   * Exécute une fonction avec rate limiting
   * @param {() => Promise<T>} fn - Fonction à exécuter
   * @returns {Promise<T>} Résultat de la fonction
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForToken();
    try {
      return await fn();
    } finally {
      // Libérer la slot parallèle
      this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
    }
  }

  /**
   * Gère une erreur 429 : met en pause globale avec backoff et jitter
   * Toutes les requêtes en attente devront attendre la fin de la pause
   * Utilise un délai de base de 2000ms + jitter pour éviter les synchronisations
   */
  handle429(): void {
    const now = Date.now();
    const jitter = this.getJitter();
    const backoffDuration = this.BASE_BACKOFF + jitter;
    
    this.isPaused = true;
    this.pauseUntil = now + backoffDuration;
    this.tokens = 0; // Vider les tokens pour forcer l'attente
    this.lastRefill = now;
    
    // SILENCE : Pas de log automatique (trop verbeux)
    // Les logs d'erreur définitives seront gérés par les services appelants
  }

  /**
   * Réinitialise le rate limiter (utile après une erreur 429)
   */
  reset(): void {
    this.tokens = 0;
    this.lastRefill = Date.now();
    this.isPaused = false;
    this.pauseUntil = 0;
  }

  /**
   * Backoff : Réduit temporairement le taux pour laisser le serveur respirer
   * Utilise un délai de base de 2000ms + jitter
   * (Alias pour handle429 pour compatibilité)
   */
  backoff(): void {
    this.handle429();
  }
}

/**
 * Instance globale singleton du rate limiter pour les appels RPC
 * Limite à 10 requêtes par seconde (Safe zone pour Helius)
 * Maximum 5 requêtes parallèles pour éviter les bursts
 */
export const rpcRateLimiter = new RpcRateLimiter(
  parseInt(process.env['RPC_RATE_LIMIT'] || '10', 10),
  parseInt(process.env['RPC_MAX_CONCURRENT'] || '5', 10)
);
