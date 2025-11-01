#!/bin/bash
# Install git hooks

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "📦 Installing git hooks..."

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "❌ Not in a git repository"
  exit 1
fi

cp "$REPO_ROOT/hooks/pre-commit" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Pre-commit hook installed"
echo ""
echo "The hook runs 'npm test' before each commit to catch:"
echo "  - Missing imports (like createAuthenticatedAgent)"
echo "  - Broken code before it reaches production"
