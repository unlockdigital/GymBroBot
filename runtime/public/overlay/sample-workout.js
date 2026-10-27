// Authored general example catalog; plans arrive through owner-approved bootstrap.
export const exerciseKB = ['goblet squat','bodyweight squat','dumbbell floor press','wall push up','dumbbell row','prone arm raise'].map(name=>({id:name,name,measurement:'reps',bodyweight_capable:['bodyweight squat','wall push up','prone arm raise'].includes(name),defaults:{sets:1,repsLow:6,repsHigh:8,weight:0}}));
export const todaysPlan = null;
export const savedPlans = [];
export const adhocCandidates = exerciseKB;
export const DAY_TYPES = [];
export function dayTypeLabel(id){return id;}
export function generateWorkout(){return null;}
export const PLATE_CHIPS = [10,5,2.5];
export const DEFAULT_REST_SECONDS = 120;
export const CARDIO_ACTIVITIES = [{id:'walk',label:'Walk',emoji:'○'},{id:'cycle',label:'Cycle',emoji:'○'}];
export const CARDIO_PHASES = [{id:'warmup',label:'Warm-up'},{id:'cardio',label:'Cardio'},{id:'cooldown',label:'Cool-down'}];
