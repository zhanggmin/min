/** Shared logical dimensions, independent of Cocos so screen constraints can be checked. */
export function battleLayout(width: number, height: number, safeLeft = 0, safeRight = 0, safeTop = 0, safeBottom = 0){
    const left = -width/2+safeLeft+12, right = width/2-safeRight-12;
    const top = height/2-safeTop, bottom = -height/2+safeBottom;
    const available = right-left;
    const portrait = height > width;
    const header = portrait ? 96 : 56, mission = portrait ? 104 : 56, dock = portrait ? 144 : 88, status = 32;
    const mapTop = top-header-mission, mapBottom = bottom+dock+status;
    return {left, right, top, bottom, available, portrait, header, mission, dock, compact: available < 1000,
        hudY: top-28, missionY: top-header-mission/2,
        mapTop, mapBottom, mapHeight: Math.max(100,mapTop-mapBottom),
        mapY: (mapTop+mapBottom)/2, dockY: bottom+dock/2, statusY: bottom+dock+status/2,
        detailWidth: available < 1000 ? 224 : 260,
        detailHeight: Math.min(252,Math.max(224,mapTop-mapBottom-16)),
        toolArea: Math.max(160,available-(portrait ? 84 : 252))};
}
