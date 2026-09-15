export type Item = 'copper' | 'coal' | 'graphite';
export type BuildingKind = 'core' | 'drill' | 'belt' | 'router' | 'junction' | 'storage' | 'crafter' | 'turret' | 'heavyTurret' | 'wall';
export type Inventory = Record<Item, number>;
export interface Point { x: number; y: number }
export interface BuildPlan extends Point { kind: BuildingKind; direction: number }
export interface Definition {
    name: string;
    cost: Partial<Inventory>;
    capacity: number;
    health: number;
    color: string;
    symbol: string;
}

export const items: Item[] = ['copper', 'coal', 'graphite'];
export const vectors: ReadonlyArray<Point> = [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}];
export const itemNames: Record<Item, string> = {copper: '铜', coal: '煤', graphite: '石墨'};
export const emptyInventory = (): Inventory => ({copper: 0, coal: 0, graphite: 0});
export const definitions: Record<BuildingKind, Definition> = {
    core: {health: 600, name: '核心', cost: {}, capacity: 100000, color: '#73e0c1', symbol: '核'},
    drill: {health: 80, name: '钻头', cost: {copper: 8}, capacity: 6, color: '#daae75', symbol: '钻'},
    belt: {health: 35, name: '传送带', cost: {copper: 1}, capacity: 3, color: '#617d94', symbol: ''},
    router: {health: 60, name: '路由器', cost: {copper: 3}, capacity: 4, color: '#e6c568', symbol: '分'},
    junction: {health: 60, name: '交叉器', cost: {copper: 3}, capacity: 6, color: '#ad99df', symbol: '＋'},
    storage: {health: 120, name: '仓库', cost: {copper: 6}, capacity: 60, color: '#92aabe', symbol: '仓'},
    crafter: {health: 120, name: '石墨厂', cost: {copper: 15}, capacity: 8, color: '#81b4ce', symbol: '厂'},
    turret: {health: 150, name: '普通炮塔', cost: {copper: 12}, capacity: 12, color: '#e89276', symbol: '炮'},
    heavyTurret: {health: 240, name: '重型炮塔', cost: {copper: 25, graphite: 10}, capacity: 12, color: '#de827e', symbol: '重'},
    wall: {health: 200, name: '墙', cost: {copper: 4}, capacity: 0, color: '#9b9995', symbol: '墙'}
};
export const logisticsKinds: BuildingKind[] = ['drill', 'belt', 'router', 'junction', 'storage', 'crafter'];

export function costText(kind: BuildingKind): string {
    return items.filter(item => definitions[kind].cost[item]).map(item => `${definitions[kind].cost[item]}${itemNames[item]}`).join(' ');
}
