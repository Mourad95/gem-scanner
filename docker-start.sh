#!/bin/bash
# Script de démarrage rapide pour Docker

set -e

echo "🐳 Démarrage du Gem Scanner avec Docker..."
echo ""

# Vérifier que .env existe
if [ ! -f .env ]; then
  echo "❌ Fichier .env non trouvé"
  echo "📝 Créez un fichier .env à partir de .env.example"
  exit 1
fi

# Vérifier que Docker est installé
if ! command -v docker &> /dev/null; then
  echo "❌ Docker n'est pas installé"
  exit 1
fi

# Vérifier que Docker Compose est installé
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo "❌ Docker Compose n'est pas installé"
  exit 1
fi

echo "✅ Vérifications OK"
echo ""

# Construire et démarrer
echo "🔨 Construction des images..."
docker-compose build

echo ""
echo "🚀 Démarrage des services..."
docker-compose up -d

echo ""
echo "⏳ Attente du démarrage d'Ollama (peut prendre 1-2 minutes pour télécharger le modèle)..."
sleep 5

# Attendre qu'Ollama soit prêt
for i in {1..30}; do
  if curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "✅ Ollama est prêt"
    break
  fi
  echo "   Attente... ($i/30)"
  sleep 2
done

echo ""
echo "📊 Statut des services:"
docker-compose ps

echo ""
echo "📝 Logs du scanner:"
echo "   docker-compose logs -f scanner"
echo ""
echo "📝 Logs d'Ollama:"
echo "   docker-compose logs -f ollama"
echo ""
echo "🛑 Pour arrêter:"
echo "   docker-compose down"
echo ""

