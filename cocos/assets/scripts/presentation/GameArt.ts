import {Color, Node, Rect, resources, Size, Sprite, SpriteFrame, Texture2D, UITransform} from 'cc';
import {BuildingKind} from '../domain/Content';

const names = ['core', 'drill', 'belt', 'router', 'junction', 'turret', 'heavyTurret', 'wall',
    'storage', 'crafter', 'enemy', 'fast', 'armored', 'ground', 'copper', 'rock'] as const;
export type ArtKind = typeof names[number] | 'coal';
const frames = new Map<ArtKind, SpriteFrame>();
let loading: Promise<void> | undefined;

/** One shared texture; retain frames across scene changes. Failed loads keep the vector fallback. */
export function loadGameArt(): Promise<void> {
    if(loading) return loading;
    loading = new Promise(resolve => {
        resources.load('art/frontier-atlas/texture', Texture2D, (error, texture) => {
            if(error){ console.warn('Game artwork unavailable:', error); loading = undefined; resolve(); return; }
            texture.addRef();
            const cell = texture.width/4;
            names.forEach((name, index) => {
                // Inset removes the generated separators and prevents texture sampling across cells.
                const left = Math.round(index%4*cell)+5, top = Math.round(Math.floor(index/4)*cell)+5;
                const side = Math.floor(cell)-10;
                const frame = new SpriteFrame();
                frame.texture = texture;
                frame.rect = new Rect(left, top, side, side);
                frame.originalSize = new Size(side, side);
                frame.packable = false;
                frames.set(name, frame);
            });
            frames.set('coal', frames.get('copper')!);
            resolve();
        });
    });
    return loading;
}

export function buildingAngle(kind: BuildingKind, direction: number): number {
    return kind === 'belt' || kind === 'drill' || kind === 'turret' || kind === 'heavyTurret' ? direction*90 : 0;
}

/** Reuse visible sprite nodes when the camera moves or entities change; no per-frame destruction. */
export class ArtLayer {
    private readonly sprites: Sprite[] = [];
    private used = 0;
    readonly node: Node;
    constructor(parent: Node, name: string){
        this.node = new Node(name); this.node.layer = parent.layer;
        parent.addChild(this.node); this.node.addComponent(UITransform);
    }
    begin(): void { this.used = 0; }
    draw(kind: ArtKind, x: number, y: number, size: number, angle = 0, tint?: string): boolean {
        const frame = frames.get(kind);
        if(!frame) return false;
        let sprite = this.sprites[this.used++];
        if(!sprite){
            const node = new Node('Art'); node.layer = this.node.layer; this.node.addChild(node);
            node.addComponent(UITransform);
            sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            this.sprites.push(sprite);
        }
        sprite.node.active = true;
        sprite.spriteFrame = frame;
        sprite.color = kind === 'coal' ? coalTint : tint ? colorFor(tint) : Color.WHITE;
        sprite.node.setPosition(x, y, 0); sprite.node.angle = angle;
        sprite.node.getComponent(UITransform)!.setContentSize(size, size);
        return true;
    }
    end(): void {
        for(let i = this.used; i < this.sprites.length; i++) this.sprites[i].node.active = false;
    }
}
const coalTint = new Color(95, 115, 133, 255);

const tints = new Map<string, Color>();
function colorFor(hex: string): Color {
    let color=tints.get(hex);
    if(!color){ color=new Color().fromHEX(hex); tints.set(hex,color); }
    return color;
}
