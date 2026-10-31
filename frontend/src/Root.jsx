import App from './App';
import PveScreen from './presentation/pve/PveScreen';
import { parsePveMatchId } from './domain/pve/pveBoard';
import './styles.css';

/**
 * Chọn màn hình React theo URL:
 *  - `?pveMatchId=<id>` : màn hình chơi với máy (PVE-UI)
 *  - còn lại            : Màn hình trận PvP/demo (`?matchId=` / `?roomCode=`) hoặc sảnh cũ
 */
export default function Root() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('pveMatchId')) {
    return <PveScreen matchId={parsePveMatchId(params.get('pveMatchId'))} />;
  }
  return <App />;
}
