/**
 * Rate Limiter pour les appels RPC Solana
 * Évite les erreurs 429 (Too Many Requests)
 * @module services/rateLimiter
 */

/**
 * Rate Limiter simple basé sur un token bucket
 * Gère aussi les requêtes parallèles pour éviter les bursts
 */
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens par seconde
  private lastRefill: number;
  private pendingRequests: number = 0;
  private maxPendingRequests: number;

  /**
   * @param {number} maxRequestsPerSecond - Nombre maximum de requêtes par seconde
   * @param {number} maxConcurrent - Nombre maximum de requêtes parallèles (défaut: 3)
   */
  constructor(maxRequestsPerSecond: number = 5, maxConcurrent: number = 3) {
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond;
    this.lastRefill = Date.now();
    this.maxPendingRequests = maxConcurrent;
  }

  /**
   * Attend qu'un token soit disponible et qu'une slot parallèle soit libre
   */
  private async waitForToken(): Promise<void> {
    // Attendre qu'une slot parallèle soit disponible
    while (this.pendingRequests >= this.maxPendingRequests) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // en secondes
    
    // Réapprovisionner les tokens
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;

    // Si on a des tokens, on peut continuer
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.pendingRequests++;
      return;
    }

    // Sinon, attendre qu'un token soit disponible
    return new Promise((resolve) => {
      const waitTime = (1 - this.tokens) / this.refillRate * 1000;
      setTimeout(() => {
        this.tokens = 0;
        this.lastRefill = Date.now();
        this.pendingRequests++;
        resolve();
      }, Math.ceil(waitTime));
    });
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
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    }
  }

  /**
   * Réinitialise le rate limiter (utile après une erreur 429)
   */
  reset(): void {
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  /**
   * Augmente le délai après une erreur 429
   */
  backoff(): void {
    // Réduire temporairement le taux pour laisser le serveur respirer
    this.tokens = 0;
    this.lastRefill = Date.now();
  }
}

/**
 * Instance globale du rate limiter pour les appels RPC
 * Limite à 3 requêtes par seconde par défaut (configurable)
 * Maximum 2 requêtes parallèles pour éviter les bursts
 * Réduit pour éviter les erreurs 429 avec Helius
 */
export const rpcRateLimiter = new RateLimiter(
  parseInt(process.env['RPC_RATE_LIMIT'] || '3', 10),
  parseInt(process.env['RPC_MAX_CONCURRENT'] || '2', 10)
);

