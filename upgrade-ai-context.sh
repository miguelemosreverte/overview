#!/bin/bash

# Upgrade existing CLAUDE.md files to include Valve Protocol
# This script detects and migrates legacy Claude projects

echo "🔄 AI Context Upgrade Tool"
echo "=========================="
echo ""

# Function to check if CLAUDE.md has Valve Protocol
has_valve_protocol() {
    if [ -f "$1" ]; then
        grep -q "Valve Protocol" "$1"
        return $?
    fi
    return 1
}

# Function to extract existing content sections
extract_existing_content() {
    local file=$1
    local temp_file=$(mktemp)
    
    # Try to extract existing project-specific content
    if grep -q "## Project" "$file"; then
        # Extract everything after first project-specific heading
        sed -n '/## Project/,$p' "$file" > "$temp_file"
        echo "$temp_file"
    else
        # Return empty if no project content found
        echo ""
    fi
}

# Function to upgrade a single CLAUDE.md file
upgrade_claude_md() {
    local file=$1
    local backup_file="${file}.pre-valve.$(date +%Y%m%d_%H%M%S)"
    
    echo "📄 Upgrading: $file"
    
    # Create backup
    cp "$file" "$backup_file"
    echo "   ✓ Backup saved to: $backup_file"
    
    # Extract any existing project content
    local existing_content=$(extract_existing_content "$file")
    
    # Create new CLAUDE.md with Valve Protocol
    cat > "$file" << 'EOF'
# Project Context and AI Workflow

## 🔄 UPGRADED: Now includes Valve Protocol for Monotonic Improvement

## Valve Protocol: Monotonic Code Improvement Workflow

### Overview
This document defines the Valve Protocol - a system ensuring that all code changes move KPIs forward, never backward. Like a one-way valve in engineering, changes can only flow in the direction of improvement.

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

### Completed Improvements
<!-- AI agents should update this section after each successful change -->

## Workflow Rules for AI Agents

### 1. Before Making Any Changes
- Read all existing documentation
- Check current test coverage
- Run existing tests to establish baseline
- Review recent commits for context

### 2. When Implementing Changes
Follow this strict order:
1. **Write tests first** (TDD approach)
2. **Implement minimal code** to pass tests
3. **Refactor** only if all metrics improve
4. **Document** changes in this file

### 3. Code Change Checklist
Before considering any change complete:
- [ ] All existing tests pass
- [ ] New tests added for new functionality
- [ ] No performance regression
- [ ] Code follows project style guide
- [ ] Documentation updated if needed

### 4. Continuous Improvement Rules
- **Small increments**: Make many small improvements rather than large changes
- **Test everything**: If it's not tested, it doesn't exist
- **Measure first**: Before optimizing, measure current state
- **Lock in gains**: Once improved, update baselines

## AI-Specific Instructions

### For Claude Code
- Use TodoWrite to track all tasks
- Consolidate project understanding in this file
- Run tests after every significant change
- Use --continue flag to maintain context across sessions

### For Gemini CLI
- Read this file first to understand project state
- Follow the same workflow as Claude
- Update metrics section after improvements
- Use checkpointing to save progress

## Session Management

### Starting a Session
```bash
# 1. Check project status
npm test
npm run lint

# 2. Review this document
cat CLAUDE.md

# 3. Set session goals (update Goals section above)
```

### During the Session
```bash
# Continuous validation
npm test -- --watch
npm run lint -- --watch

# Before each commit
npm test -- --coverage
npm run build
```

### Ending a Session
```bash
# 1. Run full test suite
npm test -- --coverage

# 2. Update metrics in this file

# 3. Commit with descriptive message
git add -A
git commit -m "feat: [description] - Coverage: X%, Tests: +N"
```

EOF
    
    # Append existing project content if found
    if [ -n "$existing_content" ] && [ -f "$existing_content" ]; then
        echo "" >> "$file"
        echo "## 📋 Original Project Context (Preserved from pre-upgrade)" >> "$file"
        echo "" >> "$file"
        cat "$existing_content" >> "$file"
        rm "$existing_content"
    fi
    
    # Add upgrade timestamp
    echo "" >> "$file"
    echo "---" >> "$file"
    echo "*Upgraded to Valve Protocol: $(date +"%Y-%m-%d %H:%M:%S")*" >> "$file"
    echo "*Previous version backed up to: $(basename "$backup_file")*" >> "$file"
    
    echo "   ✓ Upgraded with Valve Protocol"
}

# Main upgrade process
if [ "$1" == "--check" ]; then
    # Just check mode
    echo "🔍 Checking for projects needing upgrade..."
    echo ""
    
    found_legacy=0
    
    # Check current directory
    if [ -f "CLAUDE.md" ]; then
        if ! has_valve_protocol "CLAUDE.md"; then
            echo "   ⚠️  Current directory: CLAUDE.md needs upgrade"
            found_legacy=1
        else
            echo "   ✅ Current directory: Already has Valve Protocol"
        fi
    fi
    
    # Check subdirectories
    for dir in */; do
        if [ -f "${dir}CLAUDE.md" ]; then
            if ! has_valve_protocol "${dir}CLAUDE.md"; then
                echo "   ⚠️  ${dir}: CLAUDE.md needs upgrade"
                found_legacy=1
            else
                echo "   ✅ ${dir}: Already has Valve Protocol"
            fi
        fi
    done
    
    if [ $found_legacy -eq 1 ]; then
        echo ""
        echo "📢 Run './upgrade-ai-context.sh' to upgrade legacy files"
    else
        echo ""
        echo "✨ All projects already have Valve Protocol!"
    fi
    
elif [ "$1" == "--all" ]; then
    # Upgrade all found CLAUDE.md files
    echo "🔄 Upgrading all CLAUDE.md files..."
    echo ""
    
    upgraded=0
    
    # Check and upgrade current directory
    if [ -f "CLAUDE.md" ] && ! has_valve_protocol "CLAUDE.md"; then
        upgrade_claude_md "CLAUDE.md"
        upgraded=$((upgraded + 1))
    fi
    
    # Check and upgrade subdirectories
    for dir in */; do
        if [ -f "${dir}CLAUDE.md" ] && ! has_valve_protocol "${dir}CLAUDE.md"; then
            upgrade_claude_md "${dir}CLAUDE.md"
            upgraded=$((upgraded + 1))
        fi
    done
    
    echo ""
    echo "✅ Upgraded $upgraded file(s)"
    
else
    # Single file/directory mode
    target="${1:-.}"
    
    if [ -d "$target" ]; then
        # Directory specified
        claude_file="${target}/CLAUDE.md"
    else
        # File specified
        claude_file="$target"
    fi
    
    if [ ! -f "$claude_file" ]; then
        echo "❌ No CLAUDE.md found in: $target"
        echo ""
        echo "Usage:"
        echo "  ./upgrade-ai-context.sh           # Upgrade current directory"
        echo "  ./upgrade-ai-context.sh <dir>     # Upgrade specific directory"
        echo "  ./upgrade-ai-context.sh --check   # Check for files needing upgrade"
        echo "  ./upgrade-ai-context.sh --all     # Upgrade all found files"
        exit 1
    fi
    
    if has_valve_protocol "$claude_file"; then
        echo "✅ Already has Valve Protocol: $claude_file"
        echo "   No upgrade needed"
    else
        upgrade_claude_md "$claude_file"
        echo ""
        echo "✨ Upgrade complete!"
    fi
fi

# Create valve-check script if it doesn't exist
if [ ! -f "check-valve.sh" ] && [ -f "CLAUDE.md" ]; then
    echo ""
    echo "📝 Creating check-valve.sh script..."
    
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
    echo "   ✓ Created check-valve.sh"
fi