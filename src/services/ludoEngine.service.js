/**
 * Ludo Game Engine Service
 * Standard server-authoritative Ludo logic with safe zones, kill mechanics, and win checks.
 */

export const START_OFFSETS = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39
};

export const SAFE_ZONES = [0, 8, 13, 21, 26, 34, 39, 47];
export const TOTAL_MAIN_CELLS = 52;
export const HOME_STEP = 56; // 0 to 50 on main track, 51 to 55 in home path, 56 is home
export const PAWNS_PER_PLAYER = 4;

export class LudoEngine {
  /**
   * Get global board position for a pawn given its color and relative step.
   * @param {string} color - 'red', 'green', 'yellow', 'blue'
   * @param {number} step - -1 (yard), 0..50 (main track), 51..55 (home path), 56 (home)
   * @returns {number|null} global cell 0..51 or null if not on main track
   */
  static getGlobalPosition(color, step) {
    if (step < 0 || step > 50) return null;
    const offset = START_OFFSETS[color] ?? 0;
    return (offset + step) % TOTAL_MAIN_CELLS;
  }

  /**
   * Check if a given global position is a safe zone (Star or Starting point)
   * @param {number} globalPos
   * @returns {boolean}
   */
  static isSafeZone(globalPos) {
    return SAFE_ZONES.includes(globalPos);
  }

  /**
   * Calculate valid moves for all 4 pawns of a player
   * @param {Object} player - Player object with color and pawnPositions
   * @param {number} diceValue - 1 to 6
   * @returns {Array<{pawnIndex: number, canMove: boolean, currentStep: number, nextStep: number}>}
   */
  static getValidMoves(player, diceValue) {
    const validMoves = [];
    const positions = player.pawnPositions || [-1, -1, -1, -1];

    for (let i = 0; i < PAWNS_PER_PLAYER; i++) {
      const currentStep = positions[i] ?? -1;
      let canMove = false;
      let nextStep = currentStep;

      if (currentStep === -1) {
        // Base/yard: can only open with 6
        if (diceValue === 6) {
          canMove = true;
          nextStep = 0;
        }
      } else if (currentStep >= 0 && currentStep < HOME_STEP) {
        // On board or in home path
        const targetStep = currentStep + diceValue;
        if (targetStep <= HOME_STEP) {
          canMove = true;
          nextStep = targetStep;
        }
      }

      validMoves.push({
        pawnIndex: i,
        canMove,
        currentStep,
        nextStep
      });
    }

    return validMoves;
  }

  /**
   * Execute a move on the game board and calculate captures/home entries/extra turns.
   * @param {Object} room - BattleRoom document or state
   * @param {number} playerIndex - Index of the moving player
   * @param {number} pawnIndex - 0, 1, 2, or 3
   * @param {number} diceValue - 1 to 6
   * @returns {Object} result of move
   */
  static executeMove(room, playerIndex, pawnIndex, diceValue) {
    const player = room.players[playerIndex];
    if (!player) {
      return { success: false, message: 'Player not found in room' };
    }

    const currentStep = player.pawnPositions[pawnIndex] ?? -1;
    let nextStep = currentStep;

    if (currentStep === -1) {
      if (diceValue !== 6) {
        return { success: false, message: 'Must roll 6 to exit base' };
      }
      nextStep = 0;
    } else {
      nextStep = currentStep + diceValue;
      if (nextStep > HOME_STEP) {
        return { success: false, message: 'Move exceeds home stretch' };
      }
    }

    // Apply move to player's pawn
    player.pawnPositions[pawnIndex] = nextStep;

    let isCut = false;
    let cutPlayerIndex = null;
    let cutPawnIndex = null;
    let isHomeEntry = false;
    let grantExtraTurn = false;

    // Check if reached home
    if (nextStep === HOME_STEP) {
      isHomeEntry = true;
      player.pawnsInHome = (player.pawnsInHome || 0) + 1;
      grantExtraTurn = true; // Bonus roll for taking pawn home
    }

    // Check cut/kill if landing on main track (0..50)
    const newGlobalPos = this.getGlobalPosition(player.color, nextStep);
    if (newGlobalPos !== null && !this.isSafeZone(newGlobalPos)) {
      // Check all other players for overlapping pawns
      room.players.forEach((otherPlayer, otherIdx) => {
        if (otherIdx === playerIndex) return;

        otherPlayer.pawnPositions.forEach((otherStep, otherPawnIdx) => {
          const otherGlobalPos = this.getGlobalPosition(otherPlayer.color, otherStep);
          if (otherGlobalPos === newGlobalPos) {
            // Cut this pawn back to yard (-1)
            otherPlayer.pawnPositions[otherPawnIdx] = -1;
            isCut = true;
            cutPlayerIndex = otherIdx;
            cutPawnIndex = otherPawnIdx;
            grantExtraTurn = true; // Bonus roll for capturing an opponent
          }
        });
      });
    }

    // 6 also grants bonus roll
    if (diceValue === 6) {
      grantExtraTurn = true;
    }

    // Update player score (sum of pawn steps)
    player.score = player.pawnPositions.reduce((acc, step) => {
      return acc + (step > -1 ? step : 0);
    }, 0) + (player.pawnsInHome * 20);

    // Check if player has won (all 4 pawns in home, or 1 pawn in quick mode)
    const hasWon = player.pawnsInHome >= PAWNS_PER_PLAYER;

    return {
      success: true,
      playerIndex,
      playerId: player.userId,
      pawnIndex,
      fromStep: currentStep,
      toStep: nextStep,
      newGlobalPos,
      isCut,
      cutPlayerIndex,
      cutPawnIndex,
      isHomeEntry,
      grantExtraTurn,
      hasWon,
      playerScore: player.score,
      pawnsInHome: player.pawnsInHome
    };
  }
}
