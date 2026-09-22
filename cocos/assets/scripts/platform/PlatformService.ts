import {game, Game, sys} from 'cc';

interface WeChatRuntime {
    getStorageSync(key: string): unknown;
    getWindowInfo?(): {windowWidth: number; windowHeight: number; safeArea?: {left:number;right:number;top:number;bottom:number}};
    getMenuButtonBoundingClientRect?(): {left:number;right:number;top:number;bottom:number};
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
    safeInsets(): {left:number;right:number;top:number;bottom:number} {
        const inset={left:0,right:0,top:0,bottom:0};
        try {
            if(typeof wx !== 'undefined'){
                const info=wx.getWindowInfo?.(), capsule=wx.getMenuButtonBoundingClientRect?.();
                if(info){
                    const safe=info.safeArea;
                    if(safe){ inset.left=safe.left; inset.right=info.windowWidth-safe.right; inset.top=safe.top; inset.bottom=info.windowHeight-safe.bottom; }
                    if(capsule) inset.top=Math.max(inset.top,capsule.bottom+4);
                }
            }
        } catch { /* Older runtimes retain conservative edge padding in the UI. */ }
        return inset;
    }
    onVisibility(hide: () => void, show: () => void): () => void {
        game.on(Game.EVENT_HIDE, hide);
        game.on(Game.EVENT_SHOW, show);
        return () => { game.off(Game.EVENT_HIDE, hide); game.off(Game.EVENT_SHOW, show); };
    }
}
