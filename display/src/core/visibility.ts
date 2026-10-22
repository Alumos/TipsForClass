/** The desktop main process applies this policy before accepting any displayed receipt. */
export function canAcknowledgeVisible(input:{visible:boolean;minimized:boolean;overlay:boolean;overlayShown:boolean;overlayMessage:string},ids:string[]):boolean {
 return input.visible&&!input.minimized&&(!input.overlay||(input.overlayShown&&ids.every(id=>id===input.overlayMessage)));
}
