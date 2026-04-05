#!/bin/bash
# Show release notes for a jmux version in a formatted popup
# Usage: release-notes.sh <tag>

TAG="${1:-v0.0.0}"
REPO="jarredkenny/jmux"

# Colors
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

# Fetch release data
BODY=$(gh release view "$TAG" --repo "$REPO" --json body,publishedAt,name -q '"\(.name)\n\(.publishedAt)\n\(.body)"' 2>/dev/null)

if [ -z "$BODY" ]; then
    echo -e "\n  ${DIM}jmux ${TAG}${RESET}\n"
    echo -e "  ${DIM}No release notes available.${RESET}\n"
    echo -e "  ${DIM}Press q to close${RESET}"
    read -rsn1
    exit 0
fi

NAME=$(echo "$BODY" | head -1)
DATE=$(echo "$BODY" | sed -n '2p' | cut -dT -f1)
NOTES=$(echo "$BODY" | tail -n +3)

{
    echo ""
    echo -e "  ${BOLD}${GREEN}jmux ${NAME}${RESET}"
    echo -e "  ${DIM}Released ${DATE}${RESET}"
    echo ""
    # Format markdown: bold **text**, headers ##, bullet points
    echo "$NOTES" | sed \
        -e "s/^## \(.*\)/  $(printf '\033[1m')\1$(printf '\033[0m')/" \
        -e "s/^- /  • /" \
        -e "s/\*\*\([^*]*\)\*\*/$(printf '\033[1m')\1$(printf '\033[0m')/g" \
        -e "s/\`\([^\`]*\)\`/$(printf '\033[36m')\1$(printf '\033[0m')/g" \
        -e '/^$/s/^$//'
    echo ""
    echo -e "  ${DIM}https://github.com/${REPO}/releases/tag/${TAG}${RESET}"
    echo ""
    echo -e "  ${DIM}Press q to close${RESET}"
}
read -rsn1
