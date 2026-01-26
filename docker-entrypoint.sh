#!/bin/sh
set -e

# Démarrer Ollama en arrière-plan
echo "🚀 Démarrage d'Ollama..."
ollama serve &
OLLAMA_PID=$!

# Attendre que Ollama soit prêt
echo "⏳ Attente du démarrage d'Ollama..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -f http://127.0.0.1:11434/api/tags > /dev/null 2>&1 || curl -f http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "✅ Ollama est prêt"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "⚠️  Ollama prend plus de temps que prévu, mais continue..."
    break
  fi
  echo "   Tentative $i/15..."
  sleep 2
done

# Vérifier si le modèle existe
echo "🔍 Vérification du modèle qwen2.5:0.5b..."
if ! ollama list 2>/dev/null | grep -q "qwen2.5:0.5b"; then
  echo "📥 Téléchargement du modèle qwen2.5:0.5b..."
  ollama pull qwen2.5:0.5b
  echo "✅ Modèle téléchargé avec succès"
else
  echo "✅ Modèle déjà présent"
fi

# Attendre que le processus Ollama se termine (bloquant)
wait $OLLAMA_PID

