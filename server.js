require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const { ExpressPeerServer } = require('peer');

// Configuration
const config = {
  PORT: process.env.PORT || 3000,
  ADMIN_PWD: process.env.ADMIN_PWD || 'securePassword123',
  MAX_PLAYERS: process.env.MAX_PLAYERS || 8,
  GAME_TIMEOUT: process.env.GAME_TIMEOUT || 3600000
};

const app = express();
const server = http.createServer(app);

// Initialize Socket.io (only once!)
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Create PeerJS server
const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  proxied: true
});
app.use('/peerjs', peerServer);

// Game configuration
const baseBonusChance = 0.10;
const rareBonusChance = 0.03;
const predefinedTasks = [
  { task: "REMOVE AN ITEM OF CLOTHING", imageUrl: "/images/CLOTHES.jpg", category: "RISKY", points: 3 },
  { task: "20 SEC TEASE", imageUrl: "/images/FANTASY.jpg", category: "INTIMATE", points: 2, isWebcamTask: true },
  { task: "DESCRIBE A FANTASY", imageUrl: "/images/FANTASY.jpg", category: "INTIMATE", points: 2 },
  { task: "TRUTH OR DARE", imageUrl: "/images/DARE.jpg", category: "RISKY", points: 2 },
  { task: "ASK A QUESTION", imageUrl: "/images/QUESTION.jpg", category: "MILD", points: 1 },
  { task: "DRINK", imageUrl: "/images/DRINK.jpg", category: "MILD", points: 1 },
  { task: "NOTHING", imageUrl: "/images/NOTHING.jpg", category: "SAFE", points: 0 },
  { task: "MISS A TURN", imageUrl: "/images/NOTHING.jpg", category: "PENALTY", points: -1 },
  { task: "30 SEC REQUEST", imageUrl: "/images/30SEC.jpg", category: "ULTIMATE BONUS", points: 10, isUltimate: true }
];

const bonusTasks = [
  { 
    task: "BONUS! +2 Points", 
    imageUrl: "/images/BONUS.jpg", 
    category: "BONUS", 
    points: 2 
  },
  { 
    task: "RARE BONUS! One step closer to Ultimate!", 
    imageUrl: "/images/BONUS.jpg", 
    category: "RARE BONUS", 
    points: 3,
    isRare: true 
  },
  {
    task: "SWAP SCORES WITH ANOTHER PLAYER",
    imageUrl: "/images/SWAP.jpg",
    category: "SPECIAL BONUS",
    points: 0,
    isSpecial: true
  }
];

// Game state
let gameState = {
  players: [],
  playerTasks: {},
  playerBonuses: {},
  currentPlayerIndex: 0,
  skipNextTurn: false,
  playerToSkip: null,
  gameStartTime: null,
  activeWebcam: null
};

// Track connected sockets
const connectedSockets = new Set();

// Load previous game state if available
function loadGameState() {
  try {
    if (fs.existsSync('gameState.json')) {
      const savedState = JSON.parse(fs.readFileSync('gameState.json', 'utf8'));
      Object.assign(gameState, savedState);
      console.log('Game state loaded');
    }
  } catch (err) {
    console.error('Error loading game state:', err);
  }
}

function saveGameState() {
  try {
    fs.writeFileSync('gameState.json', JSON.stringify(gameState));
    console.log('Game state saved');
  } catch (err) {
    console.error('Error saving game state:', err);
  }
}

function resetGame() {
  gameState = {
    players: [],
    playerTasks: {},
    playerBonuses: {},
    currentPlayerIndex: 0,
    skipNextTurn: false,
    playerToSkip: null,
    gameStartTime: Date.now(),
    activeWebcam: null
  };
  saveGameState();
  io.emit('gameReset');
  console.log('Game has been reset');
}

// Session tokens
const activeSessions = {};

function generateSessionToken(playerId) {
  return `${playerId}-${Math.random().toString(36).substr(2, 9)}`;
}

function verifySession(playerId, token) {
  return activeSessions[playerId] === token;
}

function advanceTurn() {
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  if (gameState.skipNextTurn && gameState.players[gameState.currentPlayerIndex]?.id === gameState.playerToSkip) {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
    gameState.skipNextTurn = false;
    gameState.playerToSkip = null;
  }
  io.emit('updatePlayers', gameState.players, gameState.players[gameState.currentPlayerIndex]?.id);
}

function handleSpecialTask(task, playerId) {
  if (task.task === "SWAP SCORES WITH ANOTHER PLAYER") {
    io.to(playerId).emit('selectPlayerForSwap', gameState.players.filter(p => p.id !== playerId));
  }
}

// Clean up disconnected players
function cleanupDisconnectedPlayers() {
  const currentTime = Date.now();
  const disconnectedTimeout = 30000; // 30 seconds
  
  gameState.players = gameState.players.filter(player => {
    if (connectedSockets.has(player.id)) {
      return true;
    }
    
    if (currentTime - player.lastSeen < disconnectedTimeout) {
      return true;
    }
    
    delete gameState.playerTasks[player.id];
    delete gameState.playerBonuses[player.id];
    delete activeSessions[player.id];
    
    io.emit('receiveMessage', {
      player: 'System',
      message: `${player.name} has been removed due to inactivity.`,
      timestamp: new Date().toLocaleTimeString()
    });
    
    return false;
  });
  
  if (gameState.currentPlayerIndex >= gameState.players.length) {
    gameState.currentPlayerIndex = Math.max(0, gameState.players.length - 1);
  }
  
  saveGameState();
  io.emit('updatePlayers', gameState.players, gameState.players[gameState.currentPlayerIndex]?.id);
}

// Initialize game
loadGameState();
if (!gameState.gameStartTime) {
  gameState.gameStartTime = Date.now();
}

// Check for disconnected players every minute
setInterval(cleanupDisconnectedPlayers, 60000);

app.use(express.static('public'));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  connectedSockets.add(socket.id);

  // Handle player joining
  socket.on('joinGame', (name) => {
    if (gameState.players.length >= config.MAX_PLAYERS) {
      socket.emit('gameFull');
      return;
    }

    const sanitizedName = sanitizeHtml(name.trim(), { 
      allowedTags: [], 
      allowedAttributes: {} 
    }).substring(0, 20);

    if (!sanitizedName) {
      socket.emit('invalidName');
      return;
    }

    let player = gameState.players.find(p => p.id === socket.id);
    if (player) {
      player.lastSeen = Date.now();
      player.name = sanitizedName;
    } else {
      player = { 
        id: socket.id, 
        name: sanitizedName, 
        score: 0,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      };
      gameState.players.push(player);
      gameState.playerTasks[socket.id] = [];
      gameState.playerBonuses[socket.id] = { rareCount: 0 };
    }
    
    const sessionToken = generateSessionToken(socket.id);
    activeSessions[socket.id] = sessionToken;
    
    socket.emit('sessionToken', sessionToken);
    io.emit('updatePlayers', gameState.players, gameState.players[gameState.currentPlayerIndex]?.id);
    
    // Send list of all player IDs to new connection
    socket.emit('playerList', gameState.players.map(p => p.id));
    
    io.emit('receiveMessage', {
      player: 'System',
      message: `${sanitizedName} has joined the game!`,
      timestamp: new Date().toLocaleTimeString()
    });

    saveGameState();
  });

  // Handle player heartbeat
  socket.on('heartbeat', () => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (player) {
      player.lastSeen = Date.now();
    }
  });

  // Handle task generation
  socket.on('getTask', (token) => {
    if (!verifySession(socket.id, token)) {
      socket.emit('sessionError');
      return;
    }
    
    if (socket.id !== gameState.players[gameState.currentPlayerIndex]?.id) {
      socket.emit('notYourTurn');
      return;
    }

    let task;
    const player = gameState.players.find(p => p.id === socket.id);
    const rand = Math.random();
    
    if (gameState.playerBonuses[player.id]?.rareCount >= 3) {
      task = predefinedTasks.find(t => t.isUltimate);
      gameState.playerBonuses[player.id].rareCount = 0;
      io.emit('playUltimateSound');
      io.emit('updateBonusCount', player.id, 0);
    } 
    else if (rand < rareBonusChance) {
      task = bonusTasks.find(t => t.isRare);
      gameState.playerBonuses[player.id].rareCount++;
      io.emit('updateBonusCount', player.id, gameState.playerBonuses[player.id].rareCount);
      io.emit('playRareSound');
    }
    else if (rand < baseBonusChance) {
      const regularBonuses = bonusTasks.filter(t => !t.isRare && !t.isSpecial);
      task = regularBonuses[Math.floor(Math.random() * regularBonuses.length)];
    } 
    else {
      const allTasks = predefinedTasks.concat(Object.values(gameState.playerTasks).flat());
      task = allTasks[Math.floor(Math.random() * allTasks.length)];
    }

    if (task.task === "MISS A TURN") {
      gameState.skipNextTurn = true;
      gameState.playerToSkip = socket.id;
      io.emit('showSkipMessage', gameState.players.find(p => p.id === socket.id).name);
    }

    // Show webcam for clothing removal and tease tasks
    if (task.task === "REMOVE AN ITEM OF CLOTHING" || task.isWebcamTask) {
      console.log('Emitting showWebcam for webcam task:', task.task);
      io.to(player.id).emit('showWebcam', player.name, true, task.task);
      socket.broadcast.emit('showWebcam', player.name, false, task.task);
      gameState.activeWebcam = player.id;
    }

    if (task.isSpecial) {
      handleSpecialTask(task, player.id);
      return;
    }

    player.score += task.points;
    io.emit('displayTask', task);
    
    io.emit('addToHistory', {
      text: task.task,
      category: task.category,
      points: task.points
    });
    
    advanceTurn();
    saveGameState();
  });

  // Admin commands
  socket.on('adminCommand', (token, command, ...args) => {
    if (token !== config.ADMIN_PWD) {
      socket.emit('adminError', 'Invalid admin password');
      return;
    }

    switch(command) {
      case 'reset':
        resetGame();
        break;
      case 'kick':
        const playerId = args[0];
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
          io.to(playerId).emit('kicked');
          gameState.players = gameState.players.filter(p => p.id !== playerId);
          delete gameState.playerTasks[playerId];
          delete gameState.playerBonuses[playerId];
          delete activeSessions[playerId];
          
          if (gameState.currentPlayerIndex >= gameState.players.length) {
            gameState.currentPlayerIndex = 0;
          }
          
          io.emit('updatePlayers', gameState.players, gameState.players[gameState.currentPlayerIndex]?.id);
          io.emit('receiveMessage', {
            player: 'System',
            message: `${player.name} has been kicked from the game.`,
            timestamp: new Date().toLocaleTimeString()
          });
          saveGameState();
          socket.emit('adminSuccess', `Kicked ${player.name}`);
        }
        break;
      case 'addPoints':
        const [targetPlayerId, points] = args;
        const targetPlayer = gameState.players.find(p => p.id === targetPlayerId);
        if (targetPlayer && !isNaN(points)) {
          targetPlayer.score += parseInt(points);
          io.emit('updatePlayers', gameState.players, gameState.players[gameState.currentPlayerIndex]?.id);
          socket.emit('adminSuccess', `Added ${points} points to ${targetPlayer.name}`);
          saveGameState();
        }
        break;
      default:
        socket.emit('adminError', 'Unknown command');
    }
  });

  // Custom task creation
  socket.on('newTask', (token, taskData) => {
    if (!verifySession(socket.id, token)) return;
    
    const newTask = { 
      task: sanitizeHtml(taskData.text.trim(), { allowedTags: [], allowedAttributes: {} }).substring(0, 100),
      imageUrl: taskData.imageUrl || "/images/default.jpg",
      category: taskData.category || "CUSTOM",
      points: parseInt(taskData.points) || 1
    };
    
    console.log('Creating new task with imageUrl:', newTask.imageUrl);
    
    if (!gameState.playerTasks[socket.id]) gameState.playerTasks[socket.id] = [];
    gameState.playerTasks[socket.id].push(newTask);
    
    io.emit('receiveMessage', {
      player: 'System',
      message: `${gameState.players.find(p => p.id === socket.id).name} added a custom task!`,
      timestamp: new Date().toLocaleTimeString()
    });
    
    saveGameState();
  });

  // Timer control
  socket.on('startTimer', (token) => {
    if (!verifySession(socket.id, token)) return;
    io.emit('timerStarted');
    setTimeout(() => {
      io.emit('playAlarmSound');
    }, 120000);
  });

  // Chat messages
  socket.on('sendMessage', (token, data) => {
    if (!verifySession(socket.id, token)) return;
    
    const player = gameState.players.find(p => p.id === socket.id);
    if (player) {
      const sanitizedMessage = sanitizeHtml(data.message.trim(), { 
        allowedTags: [], 
        allowedAttributes: {} 
      }).substring(0, 200);
      
      if (sanitizedMessage) {
        io.emit('receiveMessage', {
          player: player.name,
          message: sanitizedMessage,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    }
  });

  // Webcam events
  socket.on('webcamStarted', (token) => {
    if (!verifySession(socket.id, token)) return;
    
    const player = gameState.players.find(p => p.id === socket.id);
    if (player) {
      gameState.activeWebcam = socket.id;
      io.emit('webcamStatusUpdate', {
        active: true,
        playerName: player.name,
        playerId: socket.id
      });
      io.emit('receiveMessage', {
        player: 'System',
        message: `${player.name} started their camera for the webcam task`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  socket.on('webcamStopped', (token) => {
    if (!verifySession(socket.id, token)) return;
    
    const player = gameState.players.find(p => p.id === socket.id);
    if (player && gameState.activeWebcam === socket.id) {
      gameState.activeWebcam = null;
      io.emit('webcamStatusUpdate', {
        active: false,
        playerName: player.name,
        playerId: socket.id
      });
      io.emit('receiveMessage', {
        player: 'System',
        message: `${player.name} stopped their camera`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  socket.on('webcamClosed', (token) => {
    if (!verifySession(socket.id, token)) return;
    
    if (gameState.activeWebcam === socket.id) {
      const player = gameState.players.find(p => p.id === socket.id);
      gameState.activeWebcam = null;
      io.emit('webcamStatusUpdate', {
        active: false,
        playerName: player ? player.name : 'Unknown',
        playerId: socket.id
      });
      io.emit('hideWebcam');
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    connectedSockets.delete(socket.id);
    const player = gameState.players.find(p => p.id === socket.id);
    
    if (player) {
      player.lastSeen = Date.now();
      
      // Clean up webcam if this player was using it
      if (gameState.activeWebcam === socket.id) {
        gameState.activeWebcam = null;
        io.emit('hideWebcam');
      }
      
      // Notify other players about disconnection
      io.emit('playerDisconnected', socket.id);
      
      saveGameState();
      
      io.emit('receiveMessage', {
        player: 'System',
        message: `${player.name} has disconnected.`,
        timestamp: new Date().toLocaleTimeString()
      });
      
      if (socket.id === gameState.players[gameState.currentPlayerIndex]?.id) {
        advanceTurn();
      }
    }
  });
});

// Auto-save every 5 minutes
setInterval(saveGameState, 300000);

// Auto-reset after timeout
setInterval(() => {
  if (Date.now() - gameState.gameStartTime > config.GAME_TIMEOUT) {
    resetGame();
  }
}, 60000);

server.listen(config.PORT, () => {
  console.log(`Game running on http://localhost:${config.PORT}`);
  console.log(`Admin password: ${config.ADMIN_PWD}`);
});

// Export for Vercel
module.exports = app;