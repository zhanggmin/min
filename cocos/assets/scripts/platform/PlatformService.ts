import {game, Game, sys} from 'cc';

interface WeChatRuntime {
    getStorageSync(key: string): unknown;
    setStorageSync(key: string, data: string): void;
}
declare const wx: WeChatRuntime | undefined;

export class PlatformService {
    readonly name = typeof wx !== 'undefined' ? '微信小游戏' : '本地预览';
    read(key: string): string | null {
        try {
            const value = typeof wx !== 'undefined' ? wx.getStorageSync(key) : sys.localStorage.getItem(key);
            return typeof value === 'string' && value.length > 0 ? value : null;
        } catch { return null; }
    }
    write(key: string, value: string): boolean {
        try {
            if(typeof wx !== 'undefined') wx.setStorageSync(key, value);
            else sys.localStorage.setItem(key, value);
            return true;
        } catch { return false; }
    }
    onVisibility(hide: () => void, show: () => void): () => void {
        game.on(Game.EVENT_HIDE, hide);
        game.on(Game.EVENT_SHOW, show);
        return () => { game.off(Game.EVENT_HIDE, hide); game.off(Game.EVENT_SHOW, show); };
    }
}
