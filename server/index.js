import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../dist')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Вспомогательная функция: группирует координаты в отдельные корабли (по смежности клеток)
function buildShipsFromCoords(coords) {
  const coordSet = new Set(coords);
  const visited = new Set();
  const ships = [];

  for (const key of coordSet) {
    if (visited.has(key)) continue;
    const queue = [key];
    visited.add(key);
    const shipCells = [];

    while (queue.length > 0) {
      const current = queue.shift();
      shipCells.push(current);
      const [cx, cy] = current.split(',').map(Number);
      const neighbors = [
        `${cx + 1},${cy}`,
        `${cx - 1},${cy}`,
        `${cx},${cy + 1}`,
        `${cx},${cy - 1}`
      ];

      for (const nKey of neighbors) {
        if (coordSet.has(nKey) && !visited.has(nKey)) {
          visited.add(nKey);
          queue.push(nKey);
        }
      }
    }
    ships.push({ cells: shipCells, hits: new Set() });
  }
  return ships;
}

// Расчет клеток вокруг уничтоженного корабля
function getSurroundingCells(shipCells) {
  const surrounding = new Set();
  const shipSet = new Set(shipCells);

  for (const cell of shipCells) {
    const [cx, cy] = cell.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) {
          const key = `${nx},${ny}`;
          if (!shipSet.has(key)) {
            surrounding.add(key);
          }
        }
      }
    }
  }
  return Array.from(surrounding);
}

const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('create_room', () => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms.set(roomId, {
      players: [socket.id],
      ships: new Map(), // socketId -> array of ship objects
      shots: new Map(), // socketId -> Set of fired coords
      ready: new Set(),
      currentTurn: null,
      totalHits: new Map()
    });
    socket.join(roomId);
    socket.emit('room_created', { roomId });
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_msg', 'Комната не найдена');
    if (room.players.length >= 2) return socket.emit('error_msg', 'Комната заполнена');

    room.players.push(socket.id);
    socket.join(roomId);
    socket.emit('room_joined', { roomId });
  });

  socket.on('player_ready', ({ roomId, ships }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.ships.set(socket.id, buildShipsFromCoords(ships));
    room.shots.set(socket.id, new Set());
    room.totalHits.set(socket.id, 0);
    room.ready.add(socket.id);

    if (room.ready.size === 2) {
      room.currentTurn = room.players[0];
      io.to(roomId).emit('battle_start', {
        currentTurn: room.currentTurn
      });
    }
  });

  socket.on('shoot', ({ roomId, x, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // 1. Строгая проверка очереди хода
    if (room.currentTurn !== socket.id) {
      return socket.emit('error_msg', 'Сейчас не ваш ход!');
    }

    const opponentId = room.players.find((id) => id !== socket.id);
    const opponentShips = room.ships.get(opponentId);
    const shooterShots = room.shots.get(socket.id);
    const shotKey = `${x},${y}`;

    if (shooterShots.has(shotKey)) {
      return socket.emit('error_msg', 'Сюда уже стреляли!');
    }
    shooterShots.add(shotKey);

    // 2. Проверка попадания
    let hitShip = null;
    for (const ship of opponentShips) {
      if (ship.cells.includes(shotKey)) {
        hitShip = ship;
        ship.hits.add(shotKey);
        break;
      }
    }

    const isHit = !!hitShip;
    let isSunk = false;
    let perimeter = [];

    if (isHit) {
      room.totalHits.set(socket.id, room.totalHits.get(socket.id) + 1);
      // Проверяем, потоплен ли весь корабль
      if (hitShip.hits.size === hitShip.cells.length) {
        isSunk = true;
        perimeter = getSurroundingCells(hitShip.cells);
        // Заносим клетки периметра в сделанные выстрелы, чтобы туда нельзя было стрелять
        perimeter.forEach((pCell) => shooterShots.add(pCell));
      }
      // При попадании ход ОСТАЕТСЯ у стрелявшего
    } else {
      // При промахе ход ПЕРЕХОДИТ сопернику
      room.currentTurn = opponentId;
    }

    io.to(roomId).emit('shot_result', {
      x,
      y,
      shooterId: socket.id,
      result: isHit ? 'hit' : 'miss',
      isSunk,
      sunkShipCells: isSunk ? hitShip.cells : [],
      perimeter,
      nextTurn: room.currentTurn
    });

    // 3. Проверка конца игры (20 попаданий = победа)
    if (room.totalHits.get(socket.id) === 20) {
      io.to(roomId).emit('game_over', { winnerId: socket.id });
    }
  });

  socket.on('disconnect', () => {
    // Очистка при выходе
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        io.to(roomId).emit('error_msg', 'Соперник отключился от игры');
        rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}!`);
});