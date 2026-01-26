# 🐳 Guide Docker - Gem Scanner

Ce guide explique comment déployer le Gem Scanner avec Docker, incluant Ollama pour l'analyse IA.

## 📋 Prérequis

- Docker >= 20.10
- Docker Compose >= 2.0
- Fichier `.env` configuré (voir `.env.example`)

## 🚀 Démarrage rapide

### 1. Configuration

Copiez le fichier `.env.example` vers `.env` et remplissez les variables :

```bash
cp .env.example .env
```

Éditez `.env` avec vos clés :
- `SOLANA_RPC_URL` : Votre endpoint RPC Solana (Helius recommandé)
- `SOLANA_RPC_KEY` : Clé API RPC (optionnelle)
- `TELEGRAM_BOT_TOKEN` : Token de votre bot Telegram
- `TELEGRAM_CHAT_ID` : ID du chat pour les notifications

### 2. Construction et démarrage

```bash
# Construire et démarrer tous les services
docker-compose up -d

# Voir les logs
docker-compose logs -f

# Voir les logs d'un service spécifique
docker-compose logs -f scanner
docker-compose logs -f ollama
```

### 3. Vérification

```bash
# Vérifier que les services sont en cours d'exécution
docker-compose ps

# Tester Ollama
curl http://localhost:11434/api/tags

# Vérifier les logs du scanner
docker-compose logs scanner | tail -20
```

## 🛠️ Services Docker

### Service Ollama

- **Port** : `11434`
- **Modèle** : `qwen2.5:0.5b` (téléchargé automatiquement au build)
- **Volume** : `ollama-models` (persiste les modèles entre redémarrages)
- **Healthcheck** : Vérifie que l'API est accessible toutes les 30s

### Service Scanner

- **Dépend de** : Ollama (attend que le healthcheck soit OK)
- **Variables d'environnement** : Chargées depuis `.env`
- **Réseau** : Communique avec Ollama via le réseau Docker interne

## 📊 Commandes utiles

### Gestion des services

```bash
# Démarrer les services
docker-compose up -d

# Arrêter les services
docker-compose down

# Redémarrer un service spécifique
docker-compose restart scanner
docker-compose restart ollama

# Reconstruire après modification du code
docker-compose up -d --build
```

### Logs et monitoring

```bash
# Logs en temps réel (100 dernières lignes par défaut)
make docker-logs

# Tous les logs (sans limite)
make docker-logs-all

# Logs d'un service spécifique
make docker-logs-scanner
make docker-logs-ollama

# Nettoyer les logs (force la rotation)
make docker-logs-clean

# Statistiques d'utilisation
make docker-stats
```

**Configuration des logs** : Les logs sont automatiquement limités via rotation :
- **Scanner** : 3 fichiers max de 10MB chacun (~30MB total)
- **Ollama** : 2 fichiers max de 10MB chacun (~20MB total)
- Les anciens logs sont compressés automatiquement

### Maintenance

```bash
# Nettoyer les images et volumes non utilisés
docker-compose down -v
docker system prune -a

# Voir l'espace disque utilisé
docker system df

# Supprimer le volume des modèles Ollama (réinitialise les modèles)
docker volume rm gem-scanner_ollama-models
```

## 🔧 Configuration avancée

### Modifier le modèle Ollama

Pour utiliser un autre modèle, modifiez `Dockerfile.ollama` :

```dockerfile
RUN ollama pull nom-du-modele
```

Puis reconstruisez :

```bash
docker-compose build ollama
docker-compose up -d ollama
```

### Ajuster les ressources

Modifiez `docker-compose.yml` pour limiter les ressources :

```yaml
services:
  ollama:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

### Variables d'environnement supplémentaires

Vous pouvez ajouter des variables dans `docker-compose.yml` :

```yaml
services:
  scanner:
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
```

## 🐛 Dépannage

### Ollama ne démarre pas

```bash
# Vérifier les logs
docker-compose logs ollama

# Vérifier que le port 11434 n'est pas déjà utilisé
lsof -i :11434

# Redémarrer Ollama
docker-compose restart ollama
```

### Le scanner ne peut pas joindre Ollama

```bash
# Vérifier que les deux services sont sur le même réseau
docker network inspect gem-scanner_gem-scanner-network

# Tester la connexion depuis le conteneur scanner
docker-compose exec scanner wget -O- http://ollama:11434/api/tags
```

### Le modèle n'est pas téléchargé

```bash
# Forcer le téléchargement du modèle
docker-compose exec ollama ollama pull qwen2.5:0.5b

# Vérifier les modèles disponibles
docker-compose exec ollama ollama list
```

### Problèmes de permissions

```bash
# Vérifier les permissions des volumes
docker volume inspect gem-scanner_ollama-models

# Réinitialiser les volumes si nécessaire
docker-compose down -v
docker-compose up -d
```

## 📈 Performance

### Optimisations recommandées

1. **Limiter les ressources Ollama** : Le modèle `qwen2.5:0.5b` nécessite ~500MB RAM
2. **Cache Docker** : Les builds suivants seront plus rapides grâce au cache
3. **Volumes persistants** : Les modèles sont sauvegardés entre les redémarrages

### Monitoring

```bash
# Utilisation CPU/RAM en temps réel
docker stats

# Logs avec timestamps
docker-compose logs -f -t
```

## 🔒 Sécurité

- Les services utilisent un réseau Docker isolé
- Le scanner s'exécute avec un utilisateur non-root
- Les secrets sont dans `.env` (ne pas commiter dans Git)

## 📝 Notes

- Le modèle `qwen2.5:0.5b` est téléchargé au build (première fois peut prendre quelques minutes)
- Les modèles sont persistés dans un volume Docker
- Le scanner attend automatiquement qu'Ollama soit prêt (healthcheck)

## 🆘 Support

En cas de problème :

1. Vérifiez les logs : `docker-compose logs`
2. Vérifiez que `.env` est correctement configuré
3. Vérifiez que les ports ne sont pas déjà utilisés
4. Consultez la documentation Ollama : https://ollama.ai/docs

