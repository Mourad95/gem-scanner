# 🔄 Workflow du Gem Scanner - Architecture Complète

## 📋 Table des matières

1. [Vue d'ensemble](#vue-densemble)
2. [Architecture globale](#architecture-globale)
3. [Flux de données détaillé](#flux-de-données-détaillé)
4. [Services et responsabilités](#services-et-responsabilités)
5. [Système de scoring](#système-de-scoring)
6. [Intégration IA (Ollama)](#intégration-ia-ollama)
7. [Conditions d'alerte](#conditions-dalerte)
8. [Gestion des erreurs](#gestion-des-erreurs)
9. [Performance et optimisations](#performance-et-optimisations)

---

## 🎯 Vue d'ensemble

Le **Gem Scanner** est un système de surveillance en temps réel des tokens Solana créés sur pump.fun. Il analyse automatiquement chaque nouveau token et envoie des alertes Telegram pour les opportunités Alpha (score > 70).

### Fonctionnalités principales

- ✅ Détection en temps réel via WebSocket Solana
- ✅ Analyse multi-critères (social, bonding curve, anti-rug, holders)
- ✅ Analyse sémantique IA pour détecter narratifs viraux
- ✅ Shadow Scan (analyse de distribution des holders)
- ✅ Notifications Telegram automatiques
- ✅ Gestion robuste des erreurs et timeouts

---

## 🏗️ Architecture globale

```
┌─────────────────────────────────────────────────────────────┐
│                    Point d'entrée (index.ts)                │
│  - Initialisation                                           │
│  - Gestion des signaux (SIGINT/SIGTERM)                    │
│  - Création du TokenScanner                                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              SolanaMonitor (solanaMonitor.ts)                │
│  - Connexion WebSocket Helius                                │
│  - Surveillance des logs pump.fun                            │
│  - Détection des créations de tokens                         │
│  - Extraction des métadonnées                                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ TokenData
                       ▼
┌─────────────────────────────────────────────────────────────┐
│            TokenScanner.processToken() (index.ts)            │
│  - Validation de l'adresse Solana                           │
│  - Normalisation des réserves                               │
│  - Récupération parallèle :                                 │
│    • Prix SOL (cache 5 min)                                 │
│    • Holders (timeout 800ms)                                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ TokenData + Options
                       ▼
┌─────────────────────────────────────────────────────────────┐
│          validateToken() (analyzer.ts)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. Calculs techniques (séquentiels)                 │   │
│  │    • Social Score (15 pts max)                      │   │
│  │    • Bonding Curve Score (12 pts max)               │   │
│  │    • Anti-Rug Score (15 pts max)                     │   │
│  │    • Dev Holding Penalty (-50 pts max)              │   │
│  │    • Holders Score (40 pts max / -50 pts min)       │   │
│  └─────────────────────────────────────────────────────┘   │
│                       │                                       │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2. Calcul preliminaryScore                          │   │
│  │    preliminaryScore = somme des scores techniques  │   │
│  └─────────────────────────────────────────────────────┘   │
│                       │                                       │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 3. Analyse IA (conditionnelle)                       │   │
│  │    SI preliminaryScore > 50 OU zone Alpha           │   │
│  │    └─> analyzeTokenSemantics() (aiService.ts)       │   │
│  │        • Timeout 3000ms                              │   │
│  │        • Analyse narratif + sentiment                │   │
│  │        • Détection contenu faible effort            │   │
│  └─────────────────────────────────────────────────────┘   │
│                       │                                       │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 4. Intégration résultats IA                          │   │
│  │    • +10 pts si sentimentScore > 80                  │   │
│  │    • -20 pts si isLowEffort === true                │   │
│  │    • Ajout narratif dans reasons                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                       │                                       │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 5. Calcul score final                                │   │
│  │    scoreFinal = preliminaryScore + aiScoreModifier   │   │
│  │    scoreFinal = clamp(0, 100)                         │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ TokenAnalysisResult
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Décision d'alerte (index.ts)                                 │
│  SI score > 70 (ALPHA_ALERT_THRESHOLD)                      │
│  └─> notifier.sendAlert() (notifier.ts)                       │
│      • Formatage message Telegram                            │
│      • Envoi avec métadonnées complètes                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔄 Flux de données détaillé

### Étape 1 : Détection du token

**Fichier** : `src/services/solanaMonitor.ts`

1. **WebSocket Helius** écoute les logs de transactions
2. **Filtrage** : Détecte les patterns de création de token (`create`, `create_v2`)
3. **Extraction** : Récupère le `mintAddress` depuis la transaction
4. **Enrichissement** : 
   - Priorité 1 : Métadonnées depuis la blockchain (via `blockchainDataService.ts`)
   - Priorité 2 : API pump.fun (fallback)
5. **Callback** : Appelle `onNewTokenCallback` avec `TokenData` complet

```typescript
// Exemple de TokenData généré
{
  address: "ABC123...",
  freeMint: false,
  devHolding: 5,
  metadata: {
    name: "PepeMoon",
    symbol: "PEPEM",
    description: "The ultimate Pepe memecoin...",
    image: "https://...",
    social: {
      twitter: "https://twitter.com/pepemoon",
      telegram: "https://t.me/pepemoon"
    }
  },
  reserves: {
    vSolReserves: 45,  // Zone Alpha (15-60%)
    tokenReserves: 500_000_000
  }
}
```

### Étape 2 : Traitement du token

**Fichier** : `src/index.ts` → `TokenScanner.processToken()`

1. **Validation** : Vérifie que l'adresse Solana est valide (Base58, 32-44 caractères)
2. **Normalisation** : Convertit les réserves en unités réelles (détection automatique)
3. **Récupération parallèle** :
   ```typescript
   const [solPrice, holders] = await Promise.all([
     this.getSolPrice(),           // Cache 5 min
     fetchTokenHolders(address, {  // Timeout 800ms
       limit: 10,
       signal: abortController.signal
     })
   ]);
   ```
4. **Appel analyseur** : `validateToken(tokenData, { solPriceUsd, holders })`

### Étape 3 : Analyse technique

**Fichier** : `src/services/analyzer.ts` → `validateToken()`

#### 3.1 Social Score (15 pts max)

- ✅ **+15 pts** : Twitter ET Telegram présents ET valides
- ❌ **0 pts** : Absent ou invalide

**Validation des liens** :
- Twitter : `https://(twitter.com|x.com)/[username]`
- Telegram : `https://(t.me|telegram.me)/[username]`

#### 3.2 Bonding Curve Score (12 pts max)

**Zones de scoring** :
- 🟢 **Zone Alpha (15-60%)** : +12 pts
- 🟡 **Zone acceptable (5-15% ou 60-80%)** : +6 pts
- 🔴 **Zone risque (>80%)** : +6 pts - 10 pts = -4 pts (pénalité)
- ⚫ **Trop tôt (<5%)** : 0 pts

**Formule** : `progress = ((vSolReserves - 30) / (85 - 30)) * 100`

#### 3.3 Anti-Rug Score (15 pts max)

- ✅ **+20 pts** : `freeMint === false`
- ✅ **+20 pts** : Métadonnées complètes (name, symbol, description, image)
- ✅ **+10 pts** : Métadonnées partielles (name, symbol)
- ✅ **+5 pts** : Liens sociaux valides (bonus)

**Maximum** : 15 pts (capped)

#### 3.4 Dev Holding Penalty (-50 pts max)

- 🚨 **-50 pts** : Si `devHolding > 10%`
- ✅ **0 pts** : Si `devHolding <= 10%` ou non défini

#### 3.5 Holders Score / Shadow Scan (40 pts max / -50 pts min)

**Critères de pénalité** :
- 🚨 **CRITIQUE (-50 pts)** : Un seul wallet détient > 10% (hors dev)
- 🚨 **LOURDE (-40 pts)** : Top 10 détient > 30%
- ✅ **EXCELLENT (+40 pts)** : Top 10 détient < 15%
- ✅ **BON (+20 pts)** : Top 10 détient entre 15% et 30%

**Note** : Le Shadow Scan représente 40% du score total possible.

### Étape 4 : Analyse IA (conditionnelle)

**Fichier** : `src/services/aiService.ts` → `analyzeTokenSemantics()`

#### Condition d'activation

L'IA est appelée **UNIQUEMENT** si :
- `preliminaryScore > 50` **OU**
- Token en zone Alpha (bonding curve 15-60%)

**Raison** : Ne pas gaspiller de CPU sur les tokens faibles.

#### Processus d'analyse

1. **Troncature** : Description limitée à 200 caractères
2. **Requête Ollama** :
   ```typescript
   POST http://localhost:11434/api/generate
   {
     model: "qwen2.5:0.5b",
     prompt: "[System Prompt] + [User Prompt]",
     format: "json",
     stream: false,
     options: { temperature: 0.1 }
   }
   ```
3. **Timeout** : 3000ms strict
4. **Parsing** : Validation de la structure JSON
5. **Fallback** : Valeur par défaut si erreur/timeout

#### Résultat attendu

```typescript
{
  narrative: "Pepe" | "Cat" | "PolitiFi" | "AI" | "Unknown",
  sentimentScore: 0-100,
  isLowEffort: boolean,
  riskLabel: "High" | "Medium" | "Low" | "Neutral"
}
```

#### Intégration dans le score

- ✅ **+10 pts** : Si `sentimentScore > 80` (narratif fort détecté)
- 🚨 **-20 pts** : Si `isLowEffort === true` (arnaque probable)
- 📝 **Ajout dans reasons** : Narratif et risque détectés

### Étape 5 : Calcul du score final

```typescript
scoreFinal = preliminaryScore + aiScoreModifier
scoreFinal = Math.min(100, Math.max(0, scoreFinal))
```

### Étape 6 : Décision d'alerte

**Condition** : `scoreFinal > 70` (ALPHA_ALERT_THRESHOLD)

Si condition remplie :
1. Formatage du message Telegram (via `notifier.ts`)
2. Inclusion des métadonnées complètes
3. Envoi via API Telegram Bot
4. Log de confirmation

---

## 🛠️ Services et responsabilités

### `solanaMonitor.ts`

**Responsabilité** : Surveillance WebSocket et extraction de données

- Connexion WebSocket Helius
- Détection des créations de tokens
- Extraction du mint address
- Enrichissement des métadonnées (blockchain > API)
- Gestion de la file d'attente des transactions

### `analyzer.ts`

**Responsabilité** : Analyse et scoring des tokens

- Calcul des scores techniques
- Intégration de l'analyse IA
- Calcul du score final
- Génération des raisons (reasons)

### `aiService.ts`

**Responsabilité** : Analyse sémantique via Ollama

- Appel API Ollama locale
- Parsing et validation JSON
- Gestion des timeouts et erreurs
- Retour de valeurs par défaut

### `holderService.ts`

**Responsabilité** : Récupération des holders (Shadow Scan)

- Appel API Shadow Scan
- Calcul des pourcentages de détention
- Filtrage de la bonding curve pump.fun
- Timeout 800ms

### `notifier.ts`

**Responsabilité** : Notifications Telegram

- Formatage des messages
- Envoi via API Telegram
- Gestion des cooldowns
- Tests de connexion

### `blockchainDataService.ts`

**Responsabilité** : Récupération des métadonnées depuis la blockchain

- Lecture des comptes de métadonnées
- Parsing des données on-chain
- Fallback si échec

---

## 📊 Système de scoring

### Répartition des points

| Critère | Points max | Points min | Poids |
|---------|-----------|------------|-------|
| Social Score | +15 | 0 | 15% |
| Bonding Curve | +12 | -4 | 12% |
| Anti-Rug | +15 | 0 | 15% |
| Dev Holding | 0 | -50 | -50% |
| Holders (Shadow Scan) | +40 | -50 | 40% |
| **IA Bonus** | **+10** | **-20** | **±10%** |
| **TOTAL** | **+92** | **-104** | **100%** |

### Zones de score

- 🟢 **Alpha (70-100)** : Alerte envoyée
- 🟡 **Acceptable (50-69)** : Pas d'alerte, mais suivi
- 🔴 **Faible (30-49)** : Ignoré
- ⚫ **Scam (<30)** : Détecté et loggé

### Exemple de calcul

**Token PepeMoon** :
- Social : +15 (Twitter + Telegram valides)
- Bonding Curve : +12 (Zone Alpha 27%)
- Anti-Rug : +15 (freeMint false + métadonnées complètes)
- Dev Holding : 0 (5% < 10%)
- Holders : +40 (Top 10 = 12%, excellente distribution)
- **Preliminary Score** : 82

**Analyse IA** :
- Sentiment : 85 → +10 pts
- Low Effort : false → 0 pts
- **AI Modifier** : +10

**Score Final** : 92/100 → 🚨 **ALERTE ALPHA**

---

## 🤖 Intégration IA (Ollama)

### Configuration

- **Modèle** : `qwen2.5:0.5b` (397 MB)
- **API** : `http://localhost:11434/api/generate`
- **Timeout** : 3000ms
- **Temperature** : 0.1 (déterministe)

### Prompt système

```
You are a crypto meme coin analyst. Analyze the metadata. 
Detect narrative (Dog, Cat, PolitiFi, AI, etc.) and risk. 
Output JSON: { 
  narrative: string, 
  sentimentScore: number (0-100), 
  isLowEffort: boolean, 
  riskLabel: string 
}
```

### Conditions d'appel

L'IA est appelée **UNIQUEMENT** si :
1. `preliminaryScore > 50` (token prometteur)
2. **OU** token en zone Alpha (15-60% bonding curve)

**Raison** : Optimisation des performances, ne pas analyser les tokens faibles.

### Gestion des erreurs

- **Timeout** : Retourne valeur par défaut (score 50, narrative "Unknown")
- **Erreur réseau** : Retourne valeur par défaut
- **JSON invalide** : Retourne valeur par défaut
- **Jamais de blocage** : Le scanner continue même si Ollama est indisponible

### Impact sur le score

| Résultat IA | Impact Score | Raison |
|-------------|--------------|--------|
| `sentimentScore > 80` | +10 pts | Narratif fort détecté |
| `isLowEffort === true` | -20 pts | Arnaque probable (description générique) |
| Autre | 0 pts | Informations ajoutées dans reasons uniquement |

---

## 🚨 Conditions d'alerte

### Alerte Alpha

**Condition** : `scoreFinal > 70`

**Contenu de l'alerte Telegram** :
- Nom et symbole du token
- Adresse Solana (lien explorer)
- Score détaillé
- Market Cap
- Bonding Curve Progress
- Narratif détecté (si IA activée)
- Raisons du score
- Liens sociaux

### Détection de scam

**Condition** : `score < 30` ET pénalités holders critiques

**Action** : Log détaillé (pas d'alerte, mais suivi)

---

## ⚠️ Gestion des erreurs

### Timeouts

| Service | Timeout | Action si timeout |
|---------|---------|-------------------|
| Holders (Shadow Scan) | 800ms | Continue sans holders (score 0) |
| Ollama IA | 3000ms | Valeur par défaut (score 50) |
| Prix SOL | 5000ms | Utilise cache ou fallback (100$) |
| Transaction RPC | 8000ms | Retry avec délai progressif |

### Fallbacks

- **Prix SOL** : Cache 5 min ou 100$ par défaut
- **Holders** : Score 0 si indisponible
- **IA** : Score neutre (50) si indisponible
- **Métadonnées** : API pump.fun si blockchain échoue

### Retry logic

- **Transactions** : 5 tentatives avec délai progressif (1s, 2s, 3s, 4s, 5s)
- **WebSocket** : Reconnexion automatique après 5s

---

## ⚡ Performance et optimisations

### Optimisations implémentées

1. **Cache prix SOL** : 5 minutes (évite appels API répétés)
2. **Récupération parallèle** : Prix SOL + Holders en parallèle
3. **IA conditionnelle** : Appelée uniquement pour tokens prometteurs
4. **Timeout strict** : Holders 800ms, IA 3000ms
5. **Troncature description** : 200 caractères max pour l'IA
6. **Top 10 holders** : Limite à 10 pour performance

### Métriques de performance

- **Temps moyen** : < 500ms (objectif)
- **Temps max acceptable** : < 1000ms
- **Alerte si** : > 500ms

### Monitoring

Le `PerformanceLogger` enregistre :
- Temps de traitement par token
- Nombre d'alertes envoyées
- Nombre d'erreurs
- Statistiques sur les 100 derniers tokens

---

## 📝 Exemple de log complet

```
🎯 NOUVEAU TOKEN DÉTECTÉ via Helius !
   Nom: PepeMoon
   Symbol: PEPEM
   Adresse: ABC123...

   📊 Analyse en cours...
   ✅ Holders récupérés: 10 (450ms)
   📈 Score: 92/100
      - Social: 15pts
      - Bonding Curve: 12pts
      - Anti-Rug: 15pts
      - Holders: 40pts
   🤖 AI: Narratif 'Pepe' détecté (sentiment: 85)

   🚨 ALERTE ALPHA DÉTECTÉE ! Envoi de la notification...
   ✅ Notification envoyée avec succès

✅ [450ms] → ALERTE ENVOYÉE
```

---

## 🔧 Configuration requise

### Variables d'environnement

```bash
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_RPC_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Prérequis système

- Node.js >= 18.0.0
- Ollama installé et démarré
- Modèle `qwen2.5:0.5b` téléchargé : `ollama pull qwen2.5:0.5b`

---

## 📚 Fichiers clés

| Fichier | Description |
|---------|-------------|
| `src/index.ts` | Point d'entrée, orchestration |
| `src/services/solanaMonitor.ts` | Surveillance WebSocket |
| `src/services/analyzer.ts` | Analyse et scoring |
| `src/services/aiService.ts` | Analyse sémantique IA |
| `src/services/holderService.ts` | Shadow Scan |
| `src/services/notifier.ts` | Notifications Telegram |
| `src/config/settings.ts` | Configuration |

---

## 🎓 Conclusion

Le workflow du Gem Scanner est conçu pour être :
- ✅ **Rapide** : Optimisations multiples, timeouts stricts
- ✅ **Robuste** : Gestion d'erreurs complète, fallbacks
- ✅ **Intelligent** : IA conditionnelle, Shadow Scan
- ✅ **Fiable** : Ne bloque jamais, continue même en cas d'erreur

L'intégration IA apporte une couche supplémentaire d'analyse sémantique pour détecter les narratifs viraux et les arnaques textuelles, tout en restant performante grâce à l'appel conditionnel.

