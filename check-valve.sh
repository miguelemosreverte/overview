#!/bin/bash
echo "🔍 Valve Protocol Check"
echo "======================"

# Check if tests pass
if [ -f "package.json" ]; then
    echo -n "Tests: "
    if npm test --silent 2>/dev/null; then
        echo "✅ PASS"
    else
        echo "❌ FAIL - Fix tests before proceeding"
        exit 1
    fi
fi

echo ""
echo "✅ All checks passed - OK to proceed"
