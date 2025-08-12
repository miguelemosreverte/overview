const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const WebSocket = require('ws');
const pty = require('node-pty');
const http = require('http');
const yaml = require('js-yaml');

const app = express();
app.use(express.json());
const PORT = 3000;
const DESKTOP_PATH = '/Users/miguel_lemos/Desktop';
const CLAUDE_STATUS_DIR = path.join(DESKTOP_PATH, '.claude');
const PROJECTS_CONFIG_FILE = path.join(DESKTOP_PATH, 'projects.yaml');

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for terminal sessions
const wss = new WebSocket.Server({ server, path: '/terminal' });

// Store active terminal sessions - these persist across minimize/maximize
const terminals = new Map();
const terminalStates = new Map(); // Track state for each project

// Load projects configuration
async function loadProjectsConfig() {
  try {
    const configContent = await fs.readFile(PROJECTS_CONFIG_FILE, 'utf8');
    return yaml.load(configContent) || {};
  } catch (error) {
    // Config doesn't exist yet
    return {};
  }
}

// Save projects configuration
async function saveProjectsConfig(config) {
  const yamlContent = yaml.dump(config, { indent: 2 });
  await fs.writeFile(PROJECTS_CONFIG_FILE, yamlContent);
}

// Ensure .claude directory exists
async function ensureClaudeDir() {
  try {
    await fs.mkdir(CLAUDE_STATUS_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating .claude directory:', error);
  }
}

// Save conversation state
async function saveConversationState(projectPath, projectName) {
  const timestamp = new Date().toISOString()
    .replace(/T/, '--')
    .replace(/:/g, '-')
    .replace(/\..+/, '');
  
  const statusFile = path.join(CLAUDE_STATUS_DIR, `status-${timestamp}.md`);
  
  const content = `# Claude Session Status
**Project**: ${projectName}
**Path**: ${projectPath}
**Timestamp**: ${new Date().toISOString()}
**Session**: Saved for recovery

## Session Context
This session was automatically saved when:
- The terminal was minimized
- The server was shut down

## Recovery Instructions
To resume this session, use:
\`\`\`bash
cd "${projectPath}"
claude --continue
\`\`\`

## Notes
- Session data is preserved in Claude's internal session management
- Use \`claude --resume\` to interactively select from multiple sessions
- This status file helps track when and why sessions were saved
`;
  
  try {
    await fs.writeFile(statusFile, content);
    console.log(`Session state saved to ${statusFile}`);
  } catch (error) {
    console.error('Error saving session state:', error);
  }
}

// Project metadata with descriptions
const projectDescriptions = {
  '3p-false-positives-histograms': {
    tech: 'Go, SQLite, PostgreSQL',
    description: 'Traffic incident false positives analysis and reporting system with comprehensive dashboard generation for multiple regions.',
    category: 'Data Analysis'
  },
  '3p-false-positives-histograms_old': {
    tech: 'Go, SQLite',
    description: 'Previous version of the false positives analysis system.',
    category: 'Archive'
  },
  '3p-false-positives-histograms_trying_out': {
    tech: 'Go, SQLite',
    description: 'Experimental branch for testing new analysis approaches.',
    category: 'Experimental'
  },
  '3p-scala': {
    tech: 'Scala',
    description: 'Scala-based traffic data processing experiments.',
    category: 'Data Processing'
  },
  '3p-snapshot-improving-ingest': {
    tech: 'Go',
    description: 'Improved ingestion pipeline for traffic incident snapshots.',
    category: 'Data Pipeline'
  },
  '3p-snapshot-working-here-on-ingest-while-3p-snapshot-works-on-actual-report-workflow': {
    tech: 'Python',
    description: 'Parallel development branch for ingestion improvements.',
    category: 'Data Pipeline'
  },
  '3p-snapshot': {
    tech: 'Python',
    description: 'Traffic incident data analysis with workflow automation and geospatial processing.',
    category: 'Data Analysis'
  },
  '3p-sqlite-wip': {
    tech: 'Go, SQLite',
    description: 'SQLite database exploration and direct manipulation tools.',
    category: 'Database Tools'
  },
  'agents': {
    tech: 'Python, Ollama, SQLite',
    description: 'Multi-agent AI system for database exploration and insight generation with progressive scenario-based learning.',
    category: 'AI/ML'
  },
  'architecture-rust-web-gpu': {
    tech: 'Rust, WebGPU, WGSL',
    description: '3D architectural visualization system with composable primitives, native & web support.',
    category: 'Graphics'
  },
  'blueprint-generation': {
    tech: 'Python, Scala, Ollama',
    description: 'AI-assisted exploration of SQLite databases with function calling and conversation management.',
    category: 'AI/ML'
  },
  'charts': {
    tech: 'WebGPU, JavaScript, Node.js',
    description: 'High-performance GPU-accelerated charting library with smart labeling, handles 100K+ data points.',
    category: 'Visualization'
  },
  'claude-as-a-service': {
    tech: 'Go, Claude API, SQLite',
    description: 'Production-ready CSV processor using Claude AI for schedule extraction. Processed 669K+ traffic incidents.',
    category: 'AI/Production'
  },
  'client-server-gi-working': {
    tech: 'Node.js, Express, Three.js',
    description: 'Server-based Global Illumination with texture atlas delivery and event-driven updates.',
    category: 'Graphics'
  },
  'cornell-box-restir': {
    tech: 'Rust, WebGPU, Path Tracing',
    description: 'GPU-accelerated path tracer implementing ReSTIR algorithm with voxel-based rendering.',
    category: 'Graphics'
  },
  'data-pipelines': {
    tech: 'Scala, Scio, Kafka, Docker',
    description: 'Production ETL pipeline processing Protobuf events from Kafka to MySQL with Kubernetes deployment.',
    category: 'Data Pipeline'
  },
  'four-legged-simulation': {
    tech: 'Rust, WebGPU, Bevy, Rapier3D',
    description: 'GPU-accelerated genetic algorithm for quadruped robot evolution. Evaluates 4096 individuals in parallel.',
    category: 'Simulation'
  },
  'interview-pyspark': {
    tech: 'Python, PySpark, Flask',
    description: 'Gamified PySpark learning platform with typing trainer and 12 progressive challenges.',
    category: 'Education'
  },
  'kpi-driven-agentic-coding': {
    tech: 'Go, SQLite',
    description: 'Collaborative agent-based CSV processing with schedule pattern extraction. Found 5,379 unique patterns.',
    category: 'AI/Data Processing'
  },
  'TableauConflationReports': {
    tech: 'Go, Tableau, PostgreSQL',
    description: 'Automated Tableau workbook generation for traffic incident reports with region-specific processing.',
    category: 'Reporting'
  },
  'euskadi_analisis': {
    tech: 'XML, GeoJSON',
    description: 'Regional traffic data analysis for Euskadi/Basque region with GeoJSON normalization.',
    category: 'Data Analysis'
  },
  'dot.mobi.ind': {
    tech: 'Python, HTML',
    description: 'Mobile traffic incident analysis and visualization.',
    category: 'Mobile/Analysis'
  },
  '?': {
    tech: 'HTML',
    description: 'Experimental project or placeholder.',
    category: 'Experimental'
  },
  '\\/': {
    tech: 'Go, Shell Scripts',
    description: 'Benchmark and validation system for incident resolution approaches.',
    category: 'Testing'
  }
};

// Get last modified time for a directory
async function getLastModified(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    return stats.mtime;
  } catch (error) {
    return new Date(0);
  }
}

// Check if directory is a git repo and get status
async function getGitInfo(dirPath) {
  try {
    const { stdout: isRepo } = await execPromise(`cd "${dirPath}" && git rev-parse --is-inside-work-tree 2>/dev/null`);
    if (isRepo.trim() === 'true') {
      const { stdout: lastCommit } = await execPromise(`cd "${dirPath}" && git log -1 --format="%cr" 2>/dev/null`);
      const { stdout: branch } = await execPromise(`cd "${dirPath}" && git branch --show-current 2>/dev/null`);
      const { stdout: status } = await execPromise(`cd "${dirPath}" && git status --porcelain 2>/dev/null`);
      
      return {
        isGitRepo: true,
        lastCommit: lastCommit.trim() || 'No commits',
        branch: branch.trim() || 'main',
        hasUncommittedChanges: status.trim().length > 0
      };
    }
  } catch (error) {
    // Not a git repo or git not available
  }
  return { isGitRepo: false };
}

// Get project info
async function getProjectInfo(dirName) {
  const fullPath = path.join(DESKTOP_PATH, dirName);
  const stats = await fs.stat(fullPath);
  
  if (!stats.isDirectory()) {
    return null;
  }
  
  const lastModified = await getLastModified(fullPath);
  const gitInfo = await getGitInfo(fullPath);
  const metadata = projectDescriptions[dirName] || {
    tech: 'Unknown',
    description: 'No description available.',
    category: 'Uncategorized'
  };
  
  return {
    name: dirName,
    path: fullPath,
    lastModified: lastModified,
    ...metadata,
    ...gitInfo
  };
}

// Handle WebSocket connections for terminals
wss.on('connection', (ws) => {
  let currentProjectId = null;
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.type === 'start' || msg.type === 'restore') {
      currentProjectId = msg.id;
      const projectPath = msg.path;
      const projectName = msg.name;
      
      // Check if we already have a terminal for this project
      let term = terminals.get(currentProjectId);
      
      if (!term) {
        // Check if we should continue a previous session
        const hasExistingSession = msg.isRestoring || terminalStates.get(currentProjectId);
        const claudeArgs = hasExistingSession ? 
          ['--continue', '--dangerously-skip-permissions'] : 
          ['--dangerously-skip-permissions'];
        
        // Create new PTY process
        term = pty.spawn('claude', claudeArgs, {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
          cwd: projectPath,
          env: process.env
        });
        
        terminals.set(currentProjectId, term);
        terminalStates.set(currentProjectId, {
          projectPath,
          projectName,
          active: true,
          startTime: new Date(),
          buffer: [] // Store recent output for reconnection
        });
        
        // Send output to WebSocket
        term.onData((data) => {
          // Store in buffer for reconnection (keep last 50000 chars for more history)
          const state = terminalStates.get(currentProjectId);
          if (state) {
            if (!state.buffer) {
              state.buffer = [];
            }
            state.buffer.push(data);
            
            // Calculate total buffer size
            const totalLength = state.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            if (totalLength > 50000) {
              // Keep only recent output, but preserve more history
              while (state.buffer.length > 0 && 
                     state.buffer.reduce((sum, chunk) => sum + chunk.length, 0) > 50000) {
                state.buffer.shift();
              }
            }
          }
          
          // Broadcast to all connected clients watching this terminal
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: 'output', 
                id: currentProjectId,
                data 
              }));
            }
          });
        });
        
        // Handle exit
        term.onExit(() => {
          // Save state before removing
          const state = terminalStates.get(currentProjectId);
          if (state) {
            saveConversationState(state.projectPath, state.projectName);
          }
          
          terminals.delete(currentProjectId);
          terminalStates.delete(currentProjectId);
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: 'exit',
                id: currentProjectId 
              }));
            }
          });
        });
      } else {
        // Terminal already exists - we're reconnecting
        // Make sure state has buffer array
        const state = terminalStates.get(currentProjectId);
        if (state) {
          if (!state.buffer) {
            state.buffer = [];
          }
          
          // Send buffered output to catch up the client
          if (state.buffer.length > 0) {
            // Clear the terminal first and replay all buffer
            ws.send(JSON.stringify({
              type: 'output',
              id: currentProjectId,
              data: '\x1b[2J\x1b[H' // Clear screen and move cursor to top
            }));
            
            setTimeout(() => {
              // Send all buffered data to reconnecting client
              state.buffer.forEach(chunk => {
                ws.send(JSON.stringify({
                  type: 'output',
                  id: currentProjectId,
                  data: chunk
                }));
              });
            }, 100); // Small delay to ensure client is ready
          }
        }
      }
      
      // Associate this WebSocket with the terminal
      ws.projectId = currentProjectId;
      ws.send(JSON.stringify({ type: 'ready', id: currentProjectId }));
      
    } else if (msg.type === 'input') {
      const term = terminals.get(msg.id || ws.projectId);
      if (term) {
        term.write(msg.data);
      }
    } else if (msg.type === 'resize') {
      const term = terminals.get(msg.id || ws.projectId);
      if (term) {
        term.resize(msg.cols, msg.rows);
      }
    } else if (msg.type === 'minimize') {
      // Don't kill the terminal, just mark it as minimized
      const state = terminalStates.get(msg.id);
      if (state) {
        state.minimized = true;
        saveConversationState(state.projectPath, state.projectName);
      }
    }
  });
  
  ws.on('close', () => {
    // Don't kill terminals on WebSocket close - they persist
    console.log('WebSocket closed for project:', ws.projectId);
  });
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  
  // Save all active terminal states
  for (const [id, state] of terminalStates.entries()) {
    await saveConversationState(state.projectPath, state.projectName);
    
    // Kill terminal WITHOUT sending /exit (which would get buffered and replayed)
    const term = terminals.get(id);
    if (term) {
      term.kill();
    }
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// HTML template
const generateHTML = (projects, config) => {
  const getCategoryColor = (category) => {
    const colors = {
      'Active Traffic Analysis': 'bg-red-100 text-red-800',
      'AI & Machine Learning': 'bg-purple-100 text-purple-800',
      'Graphics & Visualization': 'bg-green-100 text-green-800',
      'Data Pipelines': 'bg-orange-100 text-orange-800',
      'Simulations & Education': 'bg-yellow-100 text-yellow-800',
      'Experimental & WIP': 'bg-gray-100 text-gray-800',
      'Database & Testing Tools': 'bg-blue-100 text-blue-800',
      'Archive': 'bg-stone-100 text-stone-800'
    };
    return colors[category] || 'bg-gray-100 text-gray-800';
  };
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Desktop Projects Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
    <style>
        .category-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .project-card {
            transition: all 0.3s ease;
            border: 1px solid transparent;
        }
        .project-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            border-color: #3b82f6;
        }
        .terminal-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        .terminal-container {
            background: #1e1e1e;
            border-radius: 8px;
            padding: 20px;
            width: 90%;
            height: 80%;
            max-width: 1200px;
            display: flex;
            flex-direction: column;
        }
        .terminal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid #444;
        }
        .terminal {
            flex: 1;
            overflow: hidden;
        }
        .terminal-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 14px;
        }
        .terminal-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .terminal-btn.active {
            background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
        }
        .minimized-terminals {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 999;
        }
        .minimized-terminal {
            background: #2d3748;
            color: white;
            padding: 10px 15px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }
        .minimized-terminal:hover {
            background: #4a5568;
            transform: translateX(-5px);
        }
        
        /* Organization editor styles */
        .org-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            z-index: 2000;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .org-container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            width: 100%;
            max-width: 1200px;
            max-height: 90vh;
            overflow-y: auto;
        }
        .cluster-editor {
            background: #f7fafc;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 2px solid #e2e8f0;
        }
        .cluster-editor.drag-over {
            background: #bee3f8;
            border-color: #3182ce;
        }
        .project-pill {
            display: inline-block;
            background: white;
            padding: 8px 16px;
            margin: 4px;
            border-radius: 20px;
            font-size: 14px;
            cursor: move;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            transition: all 0.2s;
        }
        .project-pill:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
        }
        .cluster-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .cluster-name-input {
            font-size: 18px;
            font-weight: 600;
            background: transparent;
            border: 2px solid transparent;
            padding: 4px 8px;
            border-radius: 4px;
            transition: all 0.2s;
        }
        .cluster-name-input:hover, .cluster-name-input:focus {
            background: white;
            border-color: #3182ce;
            outline: none;
        }
    </style>
</head>
<body class="bg-gray-50">
    <div class="container mx-auto px-4 py-8">
        <header class="mb-8">
            <h1 class="text-4xl font-bold text-gray-900 mb-2">
                <i class="fas fa-folder-open text-blue-600 mr-3"></i>
                Desktop Projects Dashboard
            </h1>
            <div class="flex justify-between items-center">
                <p class="text-gray-600">
                    ${projects.filter(p => !config.hiddenProjects?.includes(p.name)).length} visible projects • Last updated: ${new Date().toLocaleString()}
                </p>
                <button onclick="openOrganizer()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition">
                    <i class="fas fa-edit mr-2"></i> Edit Organization
                </button>
            </div>
        </header>
        
        <div class="mb-6 flex flex-wrap gap-2">
            <button onclick="filterProjects('all')" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                All Projects
            </button>
            ${config.clusters ? config.clusters.map(cluster => `
                <button onclick="filterProjects('${cluster.name}')" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition">
                    ${cluster.name} (${cluster.projects.length})
                </button>
            `).join('') : ''}
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" id="projects-grid">
            ${projects.map(project => {
                const projectId = project.name.replace(/[^a-zA-Z0-9]/g, '_');
                
                // Check if project is hidden
                if (config.hiddenProjects && config.hiddenProjects.includes(project.name)) {
                    return '';
                }
                
                const bgColor = getCategoryColor(project.cluster);
                
                return `
                <div class="project-card bg-white rounded-lg shadow-md p-6" data-category="${project.category}" data-cluster="${project.cluster || ''}" data-name="${project.name}">
                    <div class="flex justify-between items-start mb-3">
                        <h2 class="text-xl font-semibold text-gray-900 flex-1">
                            ${project.name}
                        </h2>
                        <div class="flex gap-2 items-center">
                            <button id="btn-${projectId}" class="terminal-btn" onclick="toggleTerminal('${projectId}', '${project.path.replace(/'/g, "\\'")}', '${project.name.replace(/'/g, "\\'")}')">
                                <i class="fas fa-terminal"></i>
                                Claude
                            </button>
                            ${project.isGitRepo ? `
                                <span class="text-xs px-2 py-1 bg-gray-100 rounded">
                                    <i class="fab fa-git-alt"></i> ${project.branch}
                                </span>
                            ` : ''}
                        </div>
                    </div>
                    
                    <div class="mb-3">
                        <span class="category-badge ${bgColor}">
                            ${project.cluster || project.category}
                        </span>
                    </div>
                    
                    <p class="text-gray-600 text-sm mb-4 line-clamp-3">
                        ${project.description}
                    </p>
                    
                    <div class="space-y-2 text-xs text-gray-500">
                        <div>
                            <i class="fas fa-code mr-1"></i>
                            <span class="font-medium">Tech:</span> ${project.tech}
                        </div>
                        
                        <div>
                            <i class="fas fa-folder mr-1"></i>
                            <span class="font-medium">Path:</span>
                            <code class="bg-gray-100 px-1 rounded">${project.path}</code>
                        </div>
                        
                        <div>
                            <i class="fas fa-clock mr-1"></i>
                            <span class="font-medium">Modified:</span> ${new Date(project.lastModified).toLocaleDateString()}
                        </div>
                        
                        ${project.isGitRepo ? `
                            <div>
                                <i class="fas fa-code-branch mr-1"></i>
                                <span class="font-medium">Last commit:</span> ${project.lastCommit}
                                ${project.hasUncommittedChanges ? '<span class="ml-2 text-yellow-600">• Uncommitted changes</span>' : ''}
                            </div>
                        ` : ''}
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    </div>
    
    <!-- Organization Editor Modal -->
    <div id="orgModal" class="org-modal">
        <div class="org-container">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-2xl font-bold">Edit Project Organization</h2>
                <button onclick="closeOrganizer()" class="text-gray-500 hover:text-gray-700 text-2xl">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div id="clustersEditor">
                <!-- Clusters will be rendered here -->
            </div>
            
            <div class="flex gap-4 mt-6">
                <button onclick="addNewCluster()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                    <i class="fas fa-plus mr-2"></i> Add Cluster
                </button>
                <button onclick="saveOrganization()" class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold">
                    <i class="fas fa-save mr-2"></i> Save Changes
                </button>
            </div>
            
            <div class="mt-8 pt-6 border-t">
                <h3 class="text-lg font-semibold mb-4">Hidden Projects</h3>
                <div id="hiddenProjectsList" class="bg-gray-100 rounded-lg p-4 min-h-[60px]">
                    <!-- Hidden projects will be shown here -->
                </div>
            </div>
        </div>
    </div>
    
    <!-- Terminal Modal -->
    <div id="terminalModal" class="terminal-modal">
        <div class="terminal-container">
            <div class="terminal-header">
                <div class="text-white">
                    <i class="fas fa-terminal mr-2"></i>
                    <span id="terminalTitle">Claude Terminal</span>
                </div>
                <button onclick="minimizeTerminal()" class="text-white hover:text-yellow-400 text-xl" title="Minimize">
                    <i class="fas fa-minus"></i>
                </button>
            </div>
            <div id="terminal" class="terminal"></div>
        </div>
    </div>
    
    <!-- Minimized terminals -->
    <div id="minimizedTerminals" class="minimized-terminals"></div>
    
    <script>
        const terminals = new Map();
        const terminalConnections = new Map();
        const minimizedSessions = new Set();
        let currentTerminalId = null;
        let ws = null;
        
        // Session persistence
        const SESSION_STORAGE_KEY = 'claudeTerminalSessions';
        
        function saveSessionState() {
            const sessions = [];
            for (const [id, terminal] of terminals) {
                const btn = document.getElementById('btn-' + id);
                if (btn) {
                    sessions.push({
                        id: id,
                        path: btn.dataset.path,
                        name: btn.dataset.name,
                        minimized: minimizedSessions.has(id),
                        active: currentTerminalId === id
                    });
                }
            }
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
        }
        
        function restoreSessionsOnLoad() {
            const savedSessions = localStorage.getItem(SESSION_STORAGE_KEY);
            if (savedSessions) {
                try {
                    const sessions = JSON.parse(savedSessions);
                    sessions.forEach(session => {
                        // Mark button to show session exists
                        const btn = document.getElementById('btn-' + session.id);
                        if (btn) {
                            btn.dataset.path = session.path;
                            btn.dataset.name = session.name;
                            
                            // Add visual indicator that session is saved
                            if (!btn.classList.contains('session-exists')) {
                                btn.classList.add('session-exists');
                                btn.style.backgroundColor = '#059669'; // green to show saved session
                            }
                            
                            // If session was minimized, add to minimized set
                            if (session.minimized) {
                                minimizedSessions.add(session.id);
                                terminals.set(session.id, {}); // Placeholder for terminal
                            }
                            
                            // If session was active, restore it after a short delay
                            if (session.active && !session.minimized) {
                                setTimeout(() => {
                                    openTerminal(session.id, session.path, session.name, true);
                                }, 500);
                            }
                        }
                    });
                    
                    // Update minimized terminals display
                    if (minimizedSessions.size > 0) {
                        updateMinimizedTerminals();
                    }
                } catch (error) {
                    console.error('Error restoring sessions:', error);
                }
            }
        }
        
        // Save state before unload
        window.addEventListener('beforeunload', saveSessionState);
        
        // Restore sessions on page load
        window.addEventListener('DOMContentLoaded', () => {
            setTimeout(restoreSessionsOnLoad, 100); // Small delay to ensure DOM is ready
        });
        
        // Organization data
        const allProjects = ${JSON.stringify(projects)};
        const currentConfig = ${JSON.stringify(config)};
        let editingConfig = JSON.parse(JSON.stringify(currentConfig));
        
        function openOrganizer() {
            document.getElementById('orgModal').style.display = 'flex';
            renderClusters();
        }
        
        function closeOrganizer() {
            document.getElementById('orgModal').style.display = 'none';
        }
        
        function renderClusters() {
            const container = document.getElementById('clustersEditor');
            const hiddenContainer = document.getElementById('hiddenProjectsList');
            
            // Render clusters
            container.innerHTML = editingConfig.clusters.map((cluster, index) => \`
                <div class="cluster-editor" data-cluster-index="\${index}" ondrop="dropProject(event, \${index})" ondragover="allowDrop(event)" ondragleave="leaveDrop(event)">
                    <div class="cluster-header">
                        <input type="text" class="cluster-name-input" value="\${cluster.name}" onchange="updateClusterName(\${index}, this.value)">
                        <div class="flex items-center gap-2">
                            <span class="text-sm text-gray-600">Priority: \${cluster.priority}</span>
                            <button onclick="moveClusterUp(\${index})" class="px-2 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300" \${index === 0 ? 'disabled' : ''}>
                                <i class="fas fa-arrow-up"></i>
                            </button>
                            <button onclick="moveClusterDown(\${index})" class="px-2 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300" \${index === editingConfig.clusters.length - 1 ? 'disabled' : ''}>
                                <i class="fas fa-arrow-down"></i>
                            </button>
                            <button onclick="deleteCluster(\${index})" class="px-2 py-1 text-sm bg-red-200 text-red-700 rounded hover:bg-red-300">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="projects-container">
                        \${cluster.projects.map(projectName => {
                            const project = allProjects.find(p => p.name === projectName);
                            if (!project) return '';
                            return \`<span class="project-pill" draggable="true" ondragstart="dragProject(event, '\${projectName}')">\${projectName}</span>\`;
                        }).join('')}
                    </div>
                </div>
            \`).join('');
            
            // Render hidden projects
            hiddenContainer.innerHTML = editingConfig.hiddenProjects.map(projectName => 
                \`<span class="project-pill" draggable="true" ondragstart="dragProject(event, '\${projectName}')">\${projectName}</span>\`
            ).join('') || '<span class="text-gray-500">Drop projects here to hide them</span>';
            
            // Make hidden container droppable
            hiddenContainer.ondrop = (e) => dropToHidden(e);
            hiddenContainer.ondragover = allowDrop;
            hiddenContainer.ondragleave = leaveDrop;
        }
        
        function allowDrop(ev) {
            ev.preventDefault();
            ev.currentTarget.classList.add('drag-over');
        }
        
        function leaveDrop(ev) {
            ev.currentTarget.classList.remove('drag-over');
        }
        
        function dragProject(ev, projectName) {
            ev.dataTransfer.setData("projectName", projectName);
        }
        
        function dropProject(ev, clusterIndex) {
            ev.preventDefault();
            ev.currentTarget.classList.remove('drag-over');
            const projectName = ev.dataTransfer.getData("projectName");
            
            // Remove from all clusters and hidden
            editingConfig.clusters.forEach(cluster => {
                cluster.projects = cluster.projects.filter(p => p !== projectName);
            });
            editingConfig.hiddenProjects = editingConfig.hiddenProjects.filter(p => p !== projectName);
            
            // Add to target cluster
            editingConfig.clusters[clusterIndex].projects.push(projectName);
            
            renderClusters();
        }
        
        function dropToHidden(ev) {
            ev.preventDefault();
            ev.currentTarget.classList.remove('drag-over');
            const projectName = ev.dataTransfer.getData("projectName");
            
            // Remove from all clusters
            editingConfig.clusters.forEach(cluster => {
                cluster.projects = cluster.projects.filter(p => p !== projectName);
            });
            
            // Add to hidden if not already there
            if (!editingConfig.hiddenProjects.includes(projectName)) {
                editingConfig.hiddenProjects.push(projectName);
            }
            
            renderClusters();
        }
        
        function updateClusterName(index, name) {
            editingConfig.clusters[index].name = name;
        }
        
        function moveClusterUp(index) {
            if (index > 0) {
                const temp = editingConfig.clusters[index];
                editingConfig.clusters[index] = editingConfig.clusters[index - 1];
                editingConfig.clusters[index - 1] = temp;
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function moveClusterDown(index) {
            if (index < editingConfig.clusters.length - 1) {
                const temp = editingConfig.clusters[index];
                editingConfig.clusters[index] = editingConfig.clusters[index + 1];
                editingConfig.clusters[index + 1] = temp;
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function deleteCluster(index) {
            if (confirm('Delete this cluster? Projects will be moved to hidden.')) {
                const cluster = editingConfig.clusters[index];
                editingConfig.hiddenProjects.push(...cluster.projects);
                editingConfig.clusters.splice(index, 1);
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function addNewCluster() {
            const name = prompt('Enter cluster name:');
            if (name) {
                editingConfig.clusters.push({
                    name: name,
                    priority: editingConfig.clusters.length + 1,
                    projects: []
                });
                renderClusters();
            }
        }
        
        function saveOrganization() {
            fetch('/api/save-organization', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editingConfig)
            }).then(() => {
                window.location.reload();
            });
        }
        
        function filterProjects(category) {
            const cards = document.querySelectorAll('.project-card');
            cards.forEach(card => {
                if (category === 'all') {
                    card.style.display = 'block';
                } else {
                    const cardCluster = card.dataset.cluster;
                    card.style.display = cardCluster === category ? 'block' : 'none';
                }
            });
            
            // Update button styles
            const buttons = document.querySelectorAll('button');
            buttons.forEach(button => {
                const text = button.textContent.trim();
                if ((text.includes('All Projects') && category === 'all') || text.startsWith(category)) {
                    if (!button.className.includes('bg-purple')) {
                        button.className = button.className.replace('bg-gray-200 text-gray-700', 'bg-blue-600 text-white');
                    }
                } else if (!button.className.includes('bg-purple')) {
                    button.className = button.className.replace('bg-blue-600 text-white', 'bg-gray-200 text-gray-700');
                }
            });
        }
        
        function toggleTerminal(id, path, name) {
            if (terminals.has(id)) {
                restoreTerminal(id, name);
            } else {
                openTerminal(id, path, name);
            }
        }
        
        function openTerminal(id, path, name, isRestoring = false) {
            currentTerminalId = id;
            document.getElementById('terminalTitle').textContent = 'Claude Terminal - ' + name;
            document.getElementById('terminalModal').style.display = 'flex';
            
            minimizedSessions.delete(id);
            updateMinimizedTerminals();
            
            // Store data on button for persistence
            const btn = document.getElementById('btn-' + id);
            if (btn) {
                btn.dataset.path = path;
                btn.dataset.name = name;
            }
            
            let terminal = terminals.get(id);
            
            if (!terminal || !terminal.write) {  // Check if it's a real terminal or placeholder
                terminal = new Terminal({
                    cursorBlink: true,
                    fontSize: 14,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    theme: {
                        background: '#1e1e1e',
                        foreground: '#d4d4d4'
                    }
                });
                
                const fitAddon = new FitAddon.FitAddon();
                terminal.loadAddon(fitAddon);
                terminal.fitAddon = fitAddon;
                
                terminals.set(id, terminal);
            }
            
            const terminalDiv = document.getElementById('terminal');
            terminalDiv.innerHTML = '';
            terminal.open(terminalDiv);
            terminal.fitAddon.fit();
            
            // Always create new WebSocket for reconnection
            if (terminalConnections.has(id)) {
                // Close old connection if exists
                const oldWs = terminalConnections.get(id);
                if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                    oldWs.close();
                }
                terminalConnections.delete(id);
            }
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host + '/terminal');
            
            ws.onopen = () => {
                ws.send(JSON.stringify({ 
                    type: isRestoring ? 'restore' : 'start', 
                    id: id, 
                    path: path,
                    name: name,
                    isRestoring: isRestoring
                }));
            };
                
                ws.onmessage = (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.id === id) {
                        if (msg.type === 'output') {
                            terminal.write(msg.data);
                        } else if (msg.type === 'exit') {
                            terminal.write('\\r\\n\\x1b[31mClaude session ended.\\x1b[0m\\r\\n');
                            setTimeout(() => {
                                minimizeTerminal();
                                terminals.delete(id);
                                terminalConnections.delete(id);
                            }, 2000);
                        }
                    }
                };
                
                ws.onerror = (error) => {
                    terminal.write('\\r\\n\\x1b[31mConnection error. Please try again.\\x1b[0m\\r\\n');
                };
                
                terminal.onData((data) => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'input', id: id, data: data }));
                    }
                });
                
            terminalConnections.set(id, ws);
            
            document.getElementById('btn-' + id).classList.add('active');
            
            window.addEventListener('resize', () => {
                if (terminal.fitAddon) {
                    terminal.fitAddon.fit();
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'resize',
                            id: id,
                            cols: terminal.cols,
                            rows: terminal.rows
                        }));
                    }
                }
            });
        }
        
        function restoreTerminal(id, name) {
            currentTerminalId = id;
            document.getElementById('terminalTitle').textContent = 'Claude Terminal - ' + name;
            document.getElementById('terminalModal').style.display = 'flex';
            
            minimizedSessions.delete(id);
            updateMinimizedTerminals();
            
            const terminal = terminals.get(id);
            if (terminal) {
                const terminalDiv = document.getElementById('terminal');
                terminalDiv.innerHTML = '';
                terminal.open(terminalDiv);
                terminal.fitAddon.fit();
            }
            
            document.getElementById('btn-' + id).classList.add('active');
        }
        
        function minimizeTerminal() {
            if (currentTerminalId) {
                document.getElementById('terminalModal').style.display = 'none';
                minimizedSessions.add(currentTerminalId);
                updateMinimizedTerminals();
                
                const ws = terminalConnections.get(currentTerminalId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'minimize', id: currentTerminalId }));
                }
                
                currentTerminalId = null;
                saveSessionState(); // Save state when minimizing
            }
        }
        
        function updateMinimizedTerminals() {
            const container = document.getElementById('minimizedTerminals');
            container.innerHTML = '';
            
            minimizedSessions.forEach(id => {
                const projectName = id.replace(/_/g, ' ');
                const div = document.createElement('div');
                div.className = 'minimized-terminal';
                div.innerHTML = \`
                    <i class="fas fa-terminal"></i>
                    <span>\${projectName}</span>
                \`;
                div.onclick = () => restoreTerminal(id, projectName);
                container.appendChild(div);
            });
        }
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (document.getElementById('orgModal').style.display === 'flex') {
                    closeOrganizer();
                } else if (document.getElementById('terminalModal').style.display === 'flex') {
                    minimizeTerminal();
                }
            }
        });
        
        window.addEventListener('beforeunload', (e) => {
            // Just save state, don't send /exit command
            saveSessionState();
        });
    </script>
</body>
</html>
`;
};

// API routes
app.post('/api/save-organization', async (req, res) => {
  await saveProjectsConfig(req.body);
  res.json({ success: true });
});

app.post('/api/reset-organization', async (req, res) => {
  await saveProjectsConfig({});
  res.json({ success: true });
});

// Main route
app.get('/', async (req, res) => {
  try {
    await ensureClaudeDir();
    
    const config = await loadProjectsConfig();
    const files = await fs.readdir(DESKTOP_PATH);
    
    // Filter and get project info
    const projectPromises = files
      .filter(file => !file.startsWith('.') && !file.endsWith('.png') && !file.endsWith('.app') && !file.endsWith('.zip') && !file.endsWith('.pdf') && !file.endsWith('.json') && !file.endsWith('.xml') && !file.endsWith('.log') && !file.endsWith('.sh') && !file.endsWith('.go') && !file.endsWith('.html') && !file.endsWith('.md') && !file.endsWith('.yaml') && !file.startsWith('Screenshot'))
      .map(file => getProjectInfo(file));
    
    let projects = (await Promise.all(projectPromises))
      .filter(p => p !== null);
    
    // Apply organization if exists
    if (config.organized && config.clusters) {
      // Add cluster info to projects
      projects = projects.map(project => {
        for (const cluster of config.clusters) {
          if (cluster.projects.includes(project.name)) {
            return { ...project, cluster: cluster.name, priority: cluster.priority };
          }
        }
        return project;
      });
      
      // Sort by priority then by last modified
      projects.sort((a, b) => {
        if (a.priority && b.priority) {
          return a.priority - b.priority;
        }
        if (a.priority) return -1;
        if (b.priority) return 1;
        return b.lastModified - a.lastModified;
      });
    } else {
      // Default sort by last modified
      projects.sort((a, b) => b.lastModified - a.lastModified);
    }
    
    const html = generateHTML(projects, config);
    res.send(html);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error loading projects</h1>
          <pre>${error.message}</pre>
        </body>
      </html>
    `);
  }
});

// Initialize
ensureClaudeDir().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Home server running at http://localhost:${PORT}`);
    console.log(`📁 Serving projects from: ${DESKTOP_PATH}`);
    console.log(`🖥️  Terminal support enabled with session persistence`);
    console.log(`💾 Session states saved to: ${CLAUDE_STATUS_DIR}`);
    console.log(`🎯 Project organization saved to: ${PROJECTS_CONFIG_FILE}`);
    console.log(`📌 Use Ctrl+C for graceful shutdown with state preservation`);
  });
});