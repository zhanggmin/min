import {Color, EventTouch, Graphics, Label, Node, UITransform, Vec3} from 'cc';
import {BuildingKind, vectors} from '../domain/Content';

export const palette = {
    bg: '#DDE8D5', panel: '#FFF9ED', border: '#CBD8CC', ink: '#263F4A', muted: '#526C70',
    mint: '#246DA8', amber: '#A65B13', red: '#B94040', green: '#2F7B52', white: '#FFFFFF'
};
export const rgba = (hex: string): Color => new Color().fromHEX(hex);

/** Shared press/cancel/disabled semantics. No map input passes through a control. */
export class GameButton {
    enabled = true;
    private pointer: number | undefined;
    private selected = false;
    constructor(readonly label: Label, private readonly color: string, private readonly ink: string,
        callback: () => void){
        const node = label.node.parent!;
        node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            event.propagationStopped = true;
            if(this.pointer !== undefined) return;
            if(this.enabled){ this.pointer = event.getID() ?? undefined; this.paint(true); }
        });
        node.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            event.propagationStopped = true;
            if(event.getID() === this.pointer && !this.contains(event)){ this.pointer = undefined; this.paint(); }
        });
        node.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
            event.propagationStopped = true; this.pointer = undefined; this.paint();
        });
        node.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
            event.propagationStopped = true;
            const fire = this.enabled && event.getID() === this.pointer && this.contains(event);
            this.pointer = undefined; this.paint();
            if(fire) callback();
        });
        this.paint();
    }
    setState(enabled: boolean, selected = false): void {
        if(this.enabled === enabled && this.selected === selected) return;
        this.enabled = enabled; this.selected = selected;
        if(!enabled) this.pointer = undefined;
        this.paint();
    }
    private contains(event: EventTouch): boolean {
        const ui = this.label.node.parent!.getComponent(UITransform)!;
        const point = event.getUILocation(), p = ui.convertToNodeSpaceAR(new Vec3(point.x, point.y));
        return Math.abs(p.x) <= ui.width/2 && Math.abs(p.y) <= ui.height/2;
    }
    private paint(pressed = false): void {
        const node = this.label.node.parent!, ui = node.getComponent(UITransform)!, g = node.getComponent(Graphics)!;
        g.clear();
        g.fillColor = rgba(!this.enabled ? '#E4E9DF' : pressed ? '#B9D8E9' : this.selected ? '#E3F0FB' : this.color);
        g.roundRect(-ui.width/2, -ui.height/2, ui.width, ui.height, 10); g.fill();
        g.strokeColor = rgba(this.selected ? palette.mint : palette.border); g.lineWidth = this.selected ? 3 : 1;
        g.roundRect(-ui.width/2+1, -ui.height/2+1, ui.width-2, ui.height-2, 10); g.stroke();
        this.label.color = rgba(this.enabled ? this.ink : palette.muted);
    }
}

/** Original code-drawn artwork, shared by map buildings and tool icons. */
export function buildingIcon(g: Graphics, kind: BuildingKind, x: number, y: number, size: number, direction = 0): void {
    const fill = (color: string, left: number, bottom: number, width: number, height: number, radius = 3) => {
        g.fillColor = rgba(color); g.roundRect(x+left*size,y+bottom*size,width*size,height*size,radius); g.fill();
    };
    const circle = (color: string, radius: number) => {
        g.fillColor = rgba(color); g.circle(x,y,radius*size); g.fill();
    };
    fill('#8FA59B', -.46,-.48,.92,.88);
    fill(kind === 'drill' ? '#E5B44F' : kind === 'wall' ? '#ABB7B2' : '#7E9BAA',-.44,-.39,.88,.82);
    fill(kind === 'drill' ? '#F9D77C' : '#D6E4DF',-.36,.12,.72,.2,2);
    if(kind === 'core'){
        fill('#377FAA',-.3,-.28,.6,.6); circle('#F1FCF5',.24); circle('#50BAD7',.16);
        fill('#377FAA',-.42,-.4,.18,.22); fill('#377FAA',.24,-.4,.18,.22);
    }else if(kind === 'turret' || kind === 'heavyTurret'){
        circle('#31566E',.3); circle(kind === 'heavyTurret' ? '#7186BB' : '#5EA0C8',.23);
        g.strokeColor = rgba('#314E61'); g.lineWidth = size*.16;
        const v = vectors[direction]; g.moveTo(x,y); g.lineTo(x+v.x*size*.48,y+v.y*size*.48); g.stroke();
    }else if(kind === 'drill'){
        fill('#587480',-.2,-.25,.4,.5); circle('#EFF3DA',.15);
    }else if(kind === 'wall'){
        g.strokeColor = rgba('#708780'); g.lineWidth = 2;
        g.moveTo(x-size*.4,y); g.lineTo(x+size*.4,y); g.moveTo(x,y); g.lineTo(x,y+size*.35); g.stroke();
    }else if(kind === 'storage'){
        fill('#AD7950',-.31,-.28,.62,.55); fill('#E0B985',-.05,-.28,.1,.55,1);
    }else if(kind === 'crafter'){
        fill('#50848C',-.3,-.28,.6,.56); circle('#F3C362',.16);
    }else if(kind === 'router' || kind === 'junction'){
        circle(kind === 'router' ? '#E8B956' : '#9D88BC',.31);
        g.strokeColor = rgba('#FFF9ED'); g.lineWidth = size*.09;
        g.moveTo(x-size*.21,y); g.lineTo(x+size*.21,y); g.moveTo(x,y-size*.21); g.lineTo(x,y+size*.21); g.stroke();
    }
    if(kind === 'belt' || kind === 'drill'){
        const v = vectors[direction], side = {x:-v.y,y:v.x};
        g.strokeColor = rgba(kind === 'belt' ? '#FFF6CA' : '#31566E'); g.lineWidth = Math.max(2,size*.08);
        const offset = kind === 'drill' ? .27 : 0;
        g.moveTo(x+v.x*size*(offset-.12)+side.x*size*.15,y+v.y*size*(offset-.12)+side.y*size*.15);
        g.lineTo(x+v.x*size*(offset+.13),y+v.y*size*(offset+.13));
        g.lineTo(x+v.x*size*(offset-.12)-side.x*size*.15,y+v.y*size*(offset-.12)-side.y*size*.15); g.stroke();
    }
}
