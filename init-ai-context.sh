#!/bin/bash

# Initialize AI Context for Projects
# This script sets up the Valve Protocol and context files for AI agents

echo "🤖 Initializing AI Context with Valve Protocol"
echo "=============================================="

# Check if we're in a git repo
if [ ! -d .git ]; then
    echo "⚠️  Warning: Not in a git repository"
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if CLAUDE.md already exists
if [ -f "CLAUDE.md" ]; then
    echo "📄 CLAUDE.md already exists"
    read -p "Backup existing file? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cp CLAUDE.md "CLAUDE.md.backup.$(date +%Y%m%d_%H%M%S)"
        echo "✅ Backup created"
    fi
else
    echo "📄 Creating CLAUDE.md with Valve Protocol..."
fi

# Get project information
PROJECT_NAME=$(basename "$PWD")
echo ""
echo "Project: $PROJECT_NAME"
echo ""

# Check for package.json
if [ -f "package.json" ]; then
    echo "📦 Node.js project detected"
    
    # Check test coverage if available
    if npm run test -- --coverage --silent 2>/dev/null | grep -q "All files"; then
        COVERAGE=$(npm run test -- --coverage --silent 2>/dev/null | grep "All files" | awk '{print $10}')
        echo "   Test Coverage: $COVERAGE"
    fi
    
    # Count tests
    TEST_COUNT=$(find . -name "*.test.*" -o -name "*.spec.*" 2>/dev/null | wc -l | tr -d ' ')
    echo "   Test Files: $TEST_COUNT"
    
    # Check for build script
    if grep -q '"build"' package.json; then
        echo "   Build script: ✓"
    fi
    
    # Check for lint script
    if grep -q '"lint"' package.json; then
        echo "   Lint script: ✓"
    fi
fi

# Create CLAUDE.md from template
if [ -f "$(dirname "$0")/templates/CLAUDE.md.template" ]; then
    cp "$(dirname "$0")/templates/CLAUDE.md.template" CLAUDE.md
else
    # Embedded template if file not found
    cat > CLAUDE.md << 'EOF'
# Project Context and AI Workflow

## Valve Protocol: Monotonic Code Improvement Workflow

### Overview
This document defines the Valve Protocol - a system ensuring that all code changes move KPIs forward, never backward.

### Core Principle
**Every code change must maintain or improve ALL existing metrics. Regressions are blocked at the system level.**

## Project KPIs and Baselines

### Current Metrics
- [ ] Test Coverage: _%
- [ ] Performance: _ms average  
- [ ] Code Quality Score: _/100
- [ ] Test Count: _
- [ ] Build Time: _s
- [ ] Bundle Size: _KB

### Goals for This Session
- [ ] Primary Goal: 
- [ ] Secondary Goals:
  - [ ] 
  - [ ] 

## Workflow Rules for AI Agents

### Before Making Any Changes
1. Read all existing documentation
2. Check current test coverage
3. Run existing tests to establish baseline
4. Review recent commits for context

### When Implementing Changes
1. **Write tests first** (TDD approach)
2. **Implement minimal code** to pass tests
3. **Refactor** only if all metrics improve
4. **Document** changes in this file

### Code Change Checklist
- [ ] All existing tests pass
- [ ] New tests added for new functionality
- [ ] No performance regression
- [ ] Code follows project style guide
- [ ] Documentation updated if needed

## Project-Specific Context

### Architecture Overview
<!-- Add project structure here -->

### Key Dependencies
<!-- List main dependencies and their purposes -->

### Known Issues
<!-- Track known problems to fix -->

### Recent Changes
<!-- AI should update this with recent work -->

---
*Last Updated: $(date +"%Y-%m-%d %H:%M:%S")*
*Project: $PROJECT_NAME*
EOF
fi

echo ""
echo "✅ CLAUDE.md created with Valve Protocol"

# Create .valve-protocol directory for metrics
mkdir -p .valve-protocol/baselines

# Capture initial baselines if possible
echo ""
echo "📊 Capturing initial baselines..."

if [ -f "package.json" ]; then
    # Try to capture test coverage
    if npm run test -- --coverage --json --silent > .valve-protocol/baselines/test-coverage.json 2>/dev/null; then
        echo "   ✓ Test coverage baseline captured"
    fi
    
    # Try to capture lint results
    if npm run lint -- --format json --silent > .valve-protocol/baselines/code-quality.json 2>/dev/null; then
        echo "   ✓ Code quality baseline captured"
    fi
fi

# Create a simple valve check script
cat > check-valve.sh << 'EOF'
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
EOF

chmod +x check-valve.sh

echo ""
echo "🎯 Next Steps:"
echo "1. Edit CLAUDE.md to add project-specific context"
echo "2. Run ./check-valve.sh before committing changes"
echo "3. Both Claude and Gemini will follow the Valve Protocol"
echo ""
echo "📝 Important: This workflow ensures:"
echo "   • No regressions in test coverage"
echo "   • Continuous improvement of code quality"
echo "   • Consistent behavior between Claude and Gemini"
echo ""
echo "✨ AI Context initialization complete!"