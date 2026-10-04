import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socket = io();
const tg = window.Telegram?.WebApp;

// 10 букв по стандарту правил РФ (без Ё)
const COL_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
const ROW_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FLEET_CONFIG = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [inputRoomId, setInputRoomId] = useState('');
  const [gamePhase, setGamePhase] = useState('lobby'); // lobby | placement | battle | gameover
  const [myShips, setMyShips] = useState(new Set());
  const [myShots, setMyShots] = useState({}); // "x,y" => 'hit' | 'miss' | 'sunk' | 'perimeter'
  const [enemyShots, setEnemyShots] = useState({});
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [statusText, setStatusText] = useState('Создайте бой или подключитесь по коду');

  useEffect(() => {
    tg?.ready();
    tg?.expand();

    const inviteCode = tg?.initDataUnsafe?.start_param;
    if (inviteCode) {
      socket.emit('join_room', { roomId: inviteCode.toUpperCase() });
    }

    socket.on('room_created', ({ roomId }) => {
      setRoomId(roomId);
      setGamePhase('placement');
      setStatusText(`Комната: ${roomId}. Сформируйте эскадру`);
    });

    socket.on('room_joined', ({ roomId }) => {
      setRoomId(roomId);
      setGamePhase('placement');
      setStatusText(`Вы вошли в ${roomId}. Расставьте флот`);
    });

    socket.on('battle_start', ({ currentTurn }) => {
      setGamePhase('battle');
      const turn = socket.id === currentTurn;
      setIsMyTurn(turn);
      setStatusText(turn ? 'Бой начался! Ваш выстрел 🎯' : 'Бой начался! Ожидаем ход соперника ⏳');
      // Тактильный отклик в Telegram
      tg?.HapticFeedback?.notificationOccurred('success');
    });

    socket.on('shot_result', ({ x, y, shooterId, result, isSunk, sunkShipCells, perimeter, nextTurn }) => {
      const isShooter = socket.id === shooterId;
      const turnNow = socket.id === nextTurn;
      setIsMyTurn(turnNow);

      if (isShooter) {
        setMyShots((prev) => {
          const updated = { ...prev, [`${x},${y}`]: result };
          if (isSunk) {
            sunkShipCells.forEach((c) => (updated[c] = 'sunk'));
            perimeter.forEach((p) => {
              if (!updated[p]) updated[p] = 'perimeter';
            });
          }
          return updated;
        });

        if (isSunk) {
          setStatusText('Корабль противника уничтожен! 💥 Огонь продолжается!');
          tg?.HapticFeedback?.notificationOccurred('success');
        } else if (result === 'hit') {
          setStatusText('Точное попадание! 🎯 Стреляйте снова!');
          tg?.HapticFeedback?.impactOccurred('heavy');
        } else {
          setStatusText('Мимо ворот! Ход переходит к сопернику ⏳');
          tg?.HapticFeedback?.impactOccurred('light');
        }
      } else {
        // Мы были целью
        setEnemyShots((prev) => {
          const updated = { ...prev, [`${x},${y}`]: result };
          if (isSunk) {
            sunkShipCells.forEach((c) => (updated[c] = 'sunk'));
            perimeter.forEach((p) => {
              if (!updated[p]) updated[p] = 'perimeter';
            });
          }
          return updated;
        });

        if (isSunk) {
          setStatusText('Наш корабль потоплен! 🚨 Враг стреляет снова');
          tg?.HapticFeedback?.notificationOccurred('error');
        } else if (result === 'hit') {
          setStatusText('Попадание по нашему кораблю! ⚠️');
          tg?.HapticFeedback?.impactOccurred('heavy');
        } else {
          setStatusText('Противник промахнулся! Теперь ваш ход 🎯');
          tg?.HapticFeedback?.impactOccurred('light');
        }
      }
    });

    socket.on('game_over', ({ winnerId }) => {
      setGamePhase('gameover');
      const won = socket.id === winnerId;
      setStatusText(won ? 'Блестящая победа Совкомбанка! Флот врага на дне! 🏆' : 'Флот разбит! Поражение 💀');
      tg?.HapticFeedback?.notificationOccurred(won ? 'success' : 'error');
    });

    socket.on('error_msg', (msg) => {
      alert(msg);
    });

    return () => socket.off();
  }, []);

  // Генератор расстановки флота
  const generateRandomFleet = () => {
    const occupied = new Set();
    const isFree = (x, y) => {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (occupied.has(`${x + dx},${y + dy}`)) return false;
        }
      }
      return true;
    };

    for (const size of FLEET_CONFIG) {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 250) {
        attempts++;
        const dir = Math.random() > 0.5 ? 'H' : 'V';
        const startX = Math.floor(Math.random() * (dir === 'H' ? 10 - size + 1 : 10));
        const startY = Math.floor(Math.random() * (dir === 'V' ? 10 - size + 1 : 10));

        let canPlace = true;
        const coords = [];
        for (let i = 0; i < size; i++) {
          const cx = dir === 'H' ? startX + i : startX;
          const cy = dir === 'V' ? startY + i : startY;
          if (!isFree(cx, cy)) {
            canPlace = false;
            break;
          }
          coords.push(`${cx},${cy}`);
        }

        if (canPlace) {
          coords.forEach((c) => occupied.add(c));
          placed = true;
        }
      }
    }
    setMyShips(occupied);
    tg?.HapticFeedback?.impactOccurred('medium');
  };

  const handleShoot = (x, y) => {
    if (!isMyTurn || gamePhase !== 'battle' || myShots[`${x},${y}`]) return;
    socket.emit('shoot', { roomId, x, y });
  };

  const handleShare = () => {
    const text = `Сыграем в Морской бой? Код моей комнаты: ${roomId}`;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(text)}`);
    } else {
      navigator.clipboard.writeText(roomId);
      alert(`Код комнаты ${roomId} скопирован в буфер!`);
    }
  };

  // Отрисовка игрового поля с буквенной и цифровой шкалой
  const renderBoard = (title, isEnemy) => (
    <div className="board-container">
      <span className="board-label">{title}</span>
      <div className="grid-wrapper">
        <div className="letters-row">
          {COL_LETTERS.map((char) => (
            <div key={char} className="col-header">{char}</div>
          ))}
        </div>
        <div className="grid-with-numbers">
          <div className="numbers-col">
            {ROW_NUMBERS.map((num) => (
              <div key={num} className="row-header">{num}</div>
            ))}
          </div>
          <div className="grid">
            {Array.from({ length: 10 }).map((_, y) =>
              Array.from({ length: 10 }).map((_, x) => {
                const key = `${x},${y}`;
                if (isEnemy) {
                  const state = myShots[key];
                  return (
                    <button
                      key={key}
                      className={`cell ${state || ''}`}
                      onClick={() => handleShoot(x, y)}
                      disabled={!isMyTurn || !!state}
                    >
                      {state === 'hit' ? '✕' : state === 'sunk' ? '☠' : ''}
                    </button>
                  );
                } else {
                  const isShip = myShips.has(key);
                  const state = enemyShots[key];
                  return (
                    <div
                      key={key}
                      className={`cell ${isShip ? 'ship' : ''} ${state || ''}`}
                    >
                      {state === 'hit' ? '✕' : state === 'sunk' ? '☠' : ''}
                    </div>
                  );
                }
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app-container">
      <div className="brand-header">
        <div className="brand-dot"></div>
        <span className="brand-name">СОВКОМБАНК ИТ</span>
      </div>

      <h1 className="title">Морской бой</h1>

      <div className={`status-card ${gamePhase === 'battle' ? (isMyTurn ? 'my-turn' : 'enemy-turn') : ''}`}>
        {statusText}
      </div>

      {gamePhase === 'lobby' && (
        <div className="controls">
          <button className="btn" onClick={() => socket.emit('create_room')}>
            Создать сражение ⚔️
          </button>
          <div className="room-bar">
            <input
              className="room-input"
              placeholder="КОД"
              value={inputRoomId}
              onChange={(e) => setInputRoomId(e.target.value)}
            />
            <button
              className="btn btn-secondary"
              onClick={() => inputRoomId.trim() && socket.emit('join_room', { roomId: inputRoomId.trim().toUpperCase() })}
            >
              Войти
            </button>
          </div>
        </div>
      )}

      {gamePhase === 'placement' && (
        <>
          {renderBoard('Ваша дислокация', false)}
          <div className="controls">
            <button className="btn btn-secondary" onClick={generateRandomFleet}>
              Случайно 🎲
            </button>
            <button
              className="btn"
              onClick={() => {
                if (myShips.size !== 20) return alert('Нажмите «Случайно», чтобы расставить все 20 палуб!');
                setStatusText('Ожидаем готовности соперника...');
                socket.emit('player_ready', { roomId, ships: Array.from(myShips) });
              }}
            >
              В бой! 🚀
            </button>
            <button className="btn btn-secondary" onClick={handleShare}>
              Позвать коллегу 📲
            </button>
          </div>
        </>
      )}

      {(gamePhase === 'battle' || gamePhase === 'gameover') && (
        <>
          {renderBoard('Сектор противника (Огонь)', true)}
          {renderBoard('Флот Совкомбанка', false)}
        </>
      )}
    </div>
  );
}