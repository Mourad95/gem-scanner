/**
 * Point d'entrée principal du scanner de tokens Solana
 * VERSION "PRODUCTION READY" : Gestion optimisée de la quarantaine avec Garbage Collector
 * @module index
 */

import chalk from 'chalk';
import dotenv from 'dotenv';
import { loadSettings, validateSettings, type AppSettings } from './config/settings.js';
import { validateToken, fetchSolPrice, type TokenData } from './services/analyzer.js';
import { createNotifier } from './services/notifier.js';
import { fetchTokenHolders, type HolderData } from './services/holderService.js';
import { fetchTokenDataFromBlockchain } from './services/blockchainDataService.js';

// Charger les variables d'environnement
dotenv.config();

/**
 * Statistiques de performance
 */
interface PerformanceStats {
  totalProcessed: number;
  totalAlerts: number;
  totalErrors: number;
  avgProcessingTime: number;
  minProcessingTime: number;
  maxProcessingTime: number;
  times: number[];
}

/**
 * Logger de performance
 */
class PerformanceLogger {
  private stats: PerformanceStats = {
    totalProcessed: 0,
    totalAlerts: 0,
    totalErrors: 0,
    avgProcessingTime: 0,
    minProcessingTime: Infinity,
    maxProcessingTime: 0,
    times: [],
  };

  /**
   * Enregistre une mesure de performance
   * @param {number} processingTime - Temps de traitement en ms
   * @param {boolean} isAlert - Si une alerte a été envoyée
   * @param {boolean} isError - Si une erreur s'est produite
   */
  record(processingTime: number, isAlert: boolean, isError: boolean): void {
    this.stats.totalProcessed++;
    if (isAlert) this.stats.totalAlerts++;
    if (isError) this.stats.totalErrors++;

    this.stats.times.push(processingTime);
    this.stats.minProcessingTime = Math.min(this.stats.minProcessingTime, processingTime);
    this.stats.maxProcessingTime = Math.max(this.stats.maxProcessingTime, processingTime);

    // Calculer la moyenne sur les 100 dernières mesures
    const recentTimes = this.stats.times.slice(-100);
    this.stats.avgProcessingTime =
      recentTimes.reduce((sum, time) => sum + time, 0) / recentTimes.length;

    // Afficher le résultat avec couleur selon le temps
    const color = processingTime < 500 ? chalk.green : processingTime < 1000 ? chalk.yellow : chalk.red;
    const emoji = processingTime < 500 ? '✅' : processingTime < 1000 ? '⚠️' : '❌';
    
    console.log(
      `${emoji} ${color(`[${processingTime.toFixed(0)}ms]`)} ${chalk.gray('→')} ` +
      `${isAlert ? chalk.cyan('ALERTE ENVOYÉE') : chalk.gray('Pas d\'alerte')} ` +
      `${isError ? chalk.red('(ERREUR)') : ''}`
    );
  }

  /**
   * Affiche les statistiques globales
   */
  printStats(): void {
    console.log('\n' + chalk.bold('📊 Statistiques de Performance:'));
    console.log(`  Total traité: ${chalk.cyan(this.stats.totalProcessed)}`);
    console.log(`  Alertes envoyées: ${chalk.green(this.stats.totalAlerts)}`);
    console.log(`  Erreurs: ${chalk.red(this.stats.totalErrors)}`);
    console.log(`  Temps moyen: ${this.getColorForTime(this.stats.avgProcessingTime)(`${this.stats.avgProcessingTime.toFixed(0)}ms`)}`);
    console.log(`  Temps min: ${chalk.green(`${this.stats.minProcessingTime.toFixed(0)}ms`)}`);
    console.log(`  Temps max: ${chalk.red(`${this.stats.maxProcessingTime.toFixed(0)}ms`)}`);
    
    const under500 = this.stats.times.filter(t => t < 500).length;
    const percentage = (under500 / this.stats.times.length) * 100;
    console.log(`  < 500ms: ${this.getColorForPercentage(percentage)(`${percentage.toFixed(1)}%`)} (${under500}/${this.stats.times.length})`);
  }

  private getColorForTime(time: number): (text: string) => string {
    if (time < 500) return chalk.green;
    if (time < 1000) return chalk.yellow;
    return chalk.red;
  }

  private getColorForPercentage(percentage: number): (text: string) => string {
    if (percentage >= 90) return chalk.green;
    if (percentage >= 70) return chalk.yellow;
    return chalk.red;
  }
}

/**
 * Scanner principal - VERSION PRODUCTION READY
 */
class TokenScanner {
  private settings: AppSettings;
  private notifier: ReturnType<typeof createNotifier>;
  private performanceLogger: PerformanceLogger;
  private solPriceCache: number | null = null;
  private solPriceCacheTime: number = 0;
  private readonly SOL_PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private waitingRoom = new Map<string, { data: TokenData; firstSeen: number }>();
  private queueProcessorInterval: NodeJS.Timeout | null = null;

  constructor(settings: AppSettings) {
    this.settings = settings;
    this.notifier = createNotifier({ telegram: this.settings.telegram });
    this.performanceLogger = new PerformanceLogger();
  }

  /**
   * Initialise le scanner (précharge le prix SOL)
   */
  async initialize(): Promise<void> {
    console.log(chalk.blue('🚀 Initialisation du scanner...'));
    
    try {
      // Précharger le prix SOL pour éviter les latences
      const price = await fetchSolPrice();
      this.solPriceCache = price;
      this.solPriceCacheTime = Date.now();
      console.log(chalk.green(`✅ Prix SOL préchargé: $${price.toFixed(2)}`));
    } catch (error) {
      console.warn(chalk.yellow('⚠️ Impossible de précharger le prix SOL, utilisation du fallback'));
      this.solPriceCache = 100; // Fallback
    }

    // Tester la connexion Telegram
    try {
      await this.notifier.testConnection();
      console.log(chalk.green('✅ Connexion Telegram vérifiée'));
    } catch (error) {
      console.error(chalk.red('❌ Erreur de connexion Telegram:'), error);
      throw error;
    }
  }

  /**
   * Récupère le prix SOL (avec cache)
   */
  private async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (this.solPriceCache && now - this.solPriceCacheTime < this.SOL_PRICE_CACHE_DURATION) {
      return this.solPriceCache;
    }

    try {
      const price = await fetchSolPrice();
      this.solPriceCache = price;
      this.solPriceCacheTime = now;
      return price;
    } catch (error) {
      // Utiliser le cache même s'il est expiré
      if (this.solPriceCache !== null) {
        return this.solPriceCache;
      }
      return 100; // Fallback
    }
  }

  /**
   * Valide qu'une adresse Solana est valide (Base58, 32-44 caractères)
   * @param {string} address - Adresse à valider
   * @returns {boolean} True si l'adresse est valide
   */
  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }

    // Longueur typique d'une adresse Solana (32-44 caractères)
    if (address.length < 32 || address.length > 44) {
      return false;
    }

    // Vérifier que c'est du Base58 (pas de 0, O, I, l)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  /**
   * Ajoute un token à la Waiting Room (Quarantaine)
   * Logique simple : juste ajouter avec timestamp
   * @param {TokenData} tokenData - Données du token
   */
  async processToken(tokenData: TokenData): Promise<void> {
    try {
      // Valider l'adresse Solana avant traitement
      if (!this.isValidSolanaAddress(tokenData.address)) {
        return; // Silent fail
      }

      // Ajouter le token à la Waiting Room
      const name = tokenData.metadata?.name || tokenData.address.substring(0, 8);
      this.waitingRoom.set(tokenData.address, {
        data: tokenData,
        firstSeen: Date.now(),
      });

      // Log discret
      console.log(chalk.yellow(`⏳ [QUARANTAINE] Token ${name} mis en attente (30s)...`));
    } catch {
      // Silent fail - évite le spam
    }
  }

  /**
   * Validation finale après quarantaine
   * Récupère les données fraîches (Market Cap à jour) et valide le token
   * @param {TokenData} tokenData - Données initiales du token
   */
  private async validateAndAlert(tokenData: TokenData): Promise<void> {
    const startTime = Date.now();
    let isAlert = false;
    let isError = false;

    try {
      const name = tokenData.metadata?.name || tokenData.address.substring(0, 8);

      // CRUCIAL : Récupérer les données fraîches de la blockchain (Market Cap à jour après 30s)
      const freshBlockchainData = await fetchTokenDataFromBlockchain(
        tokenData.address,
        this.settings.solana
      );

      // Fusionner les données fraîches avec les données initiales
      const enrichedTokenData: TokenData = {
        ...tokenData,
        ...freshBlockchainData,
        address: tokenData.address, // Garder l'adresse originale
        metadata: freshBlockchainData?.metadata || tokenData.metadata,
        reserves: freshBlockchainData?.reserves || tokenData.reserves,
      };

      // Créer un AbortController pour timeout de 800ms sur fetchTokenHolders
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, 800);

      // Récupérer le prix SOL et les holders en parallèle
      const [solPrice, holders] = await Promise.all([
        this.getSolPrice(),
        fetchTokenHolders(enrichedTokenData.address, {
          solana: this.settings.solana,
          limit: 10, // Top 10 seulement pour performance
          signal: abortController.signal,
        })
          .then((result) => {
            clearTimeout(timeoutId);
            return result;
          })
          .catch(() => {
            clearTimeout(timeoutId);
            // Silent fail - continuer sans holders
            return [] as HolderData[];
          }),
      ]);

      // Analyser le token avec les données fraîches et les holders
      const analysis = await validateToken(enrichedTokenData, {
        solPriceUsd: solPrice,
        holders: holders.length > 0 ? holders : undefined,
      });

      // Afficher le score détaillé
      const scoreColor = analysis.score >= 70 ? chalk.green : analysis.score >= 50 ? chalk.yellow : chalk.red;
      console.log(scoreColor(`   📈 Score: ${analysis.score}/100`));
      console.log(chalk.gray(`      - Social: ${analysis.breakdown.socialScore}pts`));
      console.log(chalk.gray(`      - Bonding Curve: ${analysis.breakdown.bondingCurveScore}pts`));
      console.log(chalk.gray(`      - Anti-Rug: ${analysis.breakdown.antiRugScore}pts`));
      console.log(chalk.gray(`      - Holders: ${analysis.breakdown.holdersScore}pts`));
      if (analysis.breakdown.devHoldingPenalty < 0) {
        console.log(chalk.red(`      - Dev Holding: ${analysis.breakdown.devHoldingPenalty}pts`));
      }

      // Si Score > 70 : Alerte Telegram
      if (analysis.isAlphaAlert) {
        console.log(chalk.green.bold(`\n   🚨 ALERTE ALPHA DÉTECTÉE ! Envoi de la notification...`));
        try {
          await this.notifier.sendAlert(enrichedTokenData, analysis);
          isAlert = true;
          console.log(chalk.green('   ✅ Notification envoyée avec succès\n'));
        } catch (error) {
          console.error(chalk.red(`   ❌ Erreur envoi: ${error instanceof Error ? error.message : error}\n`));
        }
      } else {
        // Log de rejet compact
        const mc = analysis.marketCap.toFixed(0);
        console.log(
          chalk.yellow(`   🗑️ [REJET] Token ${name} - MC: $${mc}, Score: ${analysis.score}`)
        );
        console.log(''); // Ligne vide
      }

      const processingTime = Date.now() - startTime;
      this.performanceLogger.record(processingTime, isAlert, isError);

    } catch {
      const processingTime = Date.now() - startTime;
      isError = true;
      this.performanceLogger.record(processingTime, false, true);

      // Silent fail - évite le spam
    }
  }

  /**
   * Queue Processor (Hautes Performances)
   * Vérifie toutes les 1 seconde et traite par lots de 5
   */
  private startQueueProcessor(): void {
    const QUARANTINE_DURATION = 30 * 1000; // 30 secondes
    const CHECK_INTERVAL = 1000; // 1 seconde
    const MAX_BATCH_SIZE = 5; // Traiter jusqu'à 5 tokens simultanément
    const MAX_WAITING_ROOM_SIZE = 200; // Limite avant Garbage Collector
    const GARBAGE_COLLECT_AGE = 60 * 1000; // 60 secondes (tokens trop vieux)

    this.queueProcessorInterval = setInterval(() => {
      this.processQueue(QUARANTINE_DURATION, MAX_BATCH_SIZE, MAX_WAITING_ROOM_SIZE, GARBAGE_COLLECT_AGE);
    }, CHECK_INTERVAL);

    console.log(chalk.blue('✅ Processeur de quarantaine démarré (vérification toutes les 1s, batch de 5)'));
  }

  /**
   * Traite la file d'attente avec Garbage Collector
   * @param quarantineDuration - Durée de la quarantaine en ms
   * @param maxBatchSize - Nombre maximum de tokens à traiter simultanément
   * @param maxWaitingRoomSize - Taille maximale avant nettoyage
   * @param garbageCollectAge - Âge maximum avant suppression forcée
   */
  private async processQueue(
    quarantineDuration: number,
    maxBatchSize: number,
    maxWaitingRoomSize: number,
    garbageCollectAge: number
  ): Promise<void> {
    const now = Date.now();
    const tokensToProcess: Array<{ data: TokenData; firstSeen: number }> = [];

    // GARBAGE COLLECTOR (Anti-Crash) : Si > 200 tokens, supprimer ceux > 60s
    if (this.waitingRoom.size > maxWaitingRoomSize) {
      let removedCount = 0;
      for (const [address, entry] of this.waitingRoom.entries()) {
        const age = now - entry.firstSeen;
        if (age > garbageCollectAge) {
          this.waitingRoom.delete(address);
          removedCount++;
        }
      }
      
      if (removedCount > 0) {
        console.log(
          chalk.yellow(`🧹 Garbage Collector: ${removedCount} tokens supprimés (âge > 60s)`)
        );
      }
    }

    // Identifier les tokens prêts à être traités (30s+)
    for (const [address, entry] of this.waitingRoom.entries()) {
      const timeInQuarantine = now - entry.firstSeen;

      if (timeInQuarantine >= quarantineDuration) {
        tokensToProcess.push(entry);
        this.waitingRoom.delete(address);
      }
    }

    // TRAITEMENT PAR LOTS : Traiter jusqu'à maxBatchSize tokens simultanément
    if (tokensToProcess.length > 0) {
      // Limiter à maxBatchSize pour ne pas spammer le RPC
      const batch = tokensToProcess.slice(0, maxBatchSize);
      
      // Traiter le batch en parallèle avec Promise.all
      await Promise.all(
        batch.map((entry) =>
          this.validateAndAlert(entry.data).catch(() => {
            // Silent fail - évite le spam
          })
        )
      );

      // Si il reste des tokens à traiter, ils seront traités au prochain tick
      if (tokensToProcess.length > maxBatchSize) {
        // Remettre les tokens non traités dans la waiting room
        const remaining = tokensToProcess.slice(maxBatchSize);
        for (const entry of remaining) {
          this.waitingRoom.set(entry.data.address, entry);
        }
      }
    }
  }

  /**
   * Démarre le scanner en utilisant Helius WebSocket pour surveiller pump.fun
   */
  async start(): Promise<void> {
    console.log(chalk.blue('🔌 Démarrage du scanner pump.fun via Helius WebSocket...'));
    
    // Import dynamique pour éviter les problèmes de dépendances circulaires
    const { SolanaMonitor } = await import('./services/solanaMonitor.js');

    const monitor = new SolanaMonitor(this.settings.solana);

    try {
      await monitor.start((tokenData) => {
        // Callback appelé lorsqu'un nouveau token est détecté
        console.log(chalk.green(`\n🎯 NOUVEAU TOKEN DÉTECTÉ via Helius !`));
        console.log(chalk.cyan(`   Nom: ${tokenData.metadata?.name || 'N/A'}`));
        console.log(chalk.cyan(`   Symbol: ${tokenData.metadata?.symbol || 'N/A'}`));
        console.log(chalk.gray(`   Adresse: ${tokenData.address}`));

        // Ajouter à la quarantaine
        this.processToken(tokenData).catch(() => {
          // Silent fail
        });
      });

      console.log(chalk.green('✅ Surveillance Helius WebSocket activée'));

      // Démarrer le processeur de quarantaine
      this.startQueueProcessor();

      console.log(chalk.blue('👂 En attente de nouveaux tokens pump.fun...\n'));
    } catch (error) {
      console.error(chalk.red('❌ Erreur lors de la connexion Helius WebSocket:'), error);
      console.log(chalk.yellow('\n⚠️  Fallback: Le scanner ne peut pas surveiller les nouveaux tokens automatiquement.\n'));
    }
  }

  /**
   * Arrête le scanner
   */
  stop(): void {
    // Arrêter le processeur de quarantaine
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
    }

    // Afficher les statistiques
    this.performanceLogger.printStats();

    // Afficher le nombre de tokens encore en quarantaine
    if (this.waitingRoom.size > 0) {
      console.log(chalk.yellow(`\n⚠️ ${this.waitingRoom.size} token(s) encore en quarantaine`));
    }
  }
}

/**
 * Point d'entrée principal
 */
async function main(): Promise<void> {
  try {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║     GEM SCANNER - Solana Tokens      ║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

    // Charger et valider la configuration
    const settings = loadSettings();
    validateSettings(settings);

    // Créer et initialiser le scanner
    const scanner = new TokenScanner(settings);
    await scanner.initialize();

    // Gérer l'arrêt propre
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\n⚠️ Arrêt du scanner...'));
      scanner.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log(chalk.yellow('\n\n⚠️ Arrêt du scanner...'));
      scanner.stop();
      process.exit(0);
    });

    // Démarrer le scanner
    await scanner.start();
  } catch (error) {
    console.error(chalk.red('❌ Erreur fatale:'), error);
    process.exit(1);
  }
}

// Lancer l'application
main().catch((error) => {
  console.error(chalk.red('Erreur non gérée:'), error);
  process.exit(1);
});
