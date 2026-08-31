'use strict';

const aliases = Object.freeze({
    generic: 'other',
    other: 'other',
    run: 'running',
    running: 'running',
    indoor_running: 'running',
    street_running: 'running',
    track_running: 'running',
    trail_running: 'running',
    treadmill_running: 'running',
    treadmill: 'running',
    ultra_run: 'running',
    virtual_running: 'running',
    biking: 'cycling',
    bmx: 'cycling',
    cyclocross: 'cycling',
    cycling: 'cycling',
    e_bike_fitness: 'cycling',
    e_biking: 'cycling',
    gravel_cycling: 'cycling',
    indoor_cycling: 'cycling',
    mountain_biking: 'cycling',
    road_biking: 'cycling',
    virtual_ride: 'cycling',
    lap_swimming: 'swimming',
    open_water_swimming: 'swimming',
    swimming: 'swimming',
    walking: 'walking',
    hiking: 'hiking',
    mountaineering: 'climbing',
    bouldering: 'climbing',
    floor_climbing: 'climbing',
    indoor_climbing: 'climbing',
    rock_climbing: 'climbing',
    cardio: 'cardio',
    cardio_training: 'cardio',
    elliptical: 'cardio',
    fitness_equipment: 'cardio',
    hiit: 'cardio',
    amrap: 'cardio',
    emom: 'cardio',
    indoor_cardio: 'cardio',
    stair_climbing: 'cardio',
    stair_stepper: 'cardio',
    tabata: 'cardio',
    strength: 'strength',
    strength_training: 'strength',
    weight_training: 'strength',
    indoor_rowing: 'rowing',
    rowing: 'rowing',
    kayaking: 'kayaking',
    stand_up_paddleboarding: 'paddling',
    sup: 'paddling',
    yoga: 'yoga',
    pilates: 'pilates',
    breathwork: 'breathwork',
    breathing: 'breathwork',
    alpine_skiing: 'skiing',
    backcountry_skiing: 'skiing',
    cross_country_skiing: 'skiing',
    resort_skiing: 'skiing',
    skiing: 'skiing',
    indoor_skiing: 'skiing',
    indoor_walking: 'walking',
    snowboarding: 'snowboarding',
    multisport: 'multisport',
    multi_sport: 'multisport',
    training: 'training',
    water_sport: 'water-sport',
    water_sports: 'water-sport',
    winter_sport: 'winter-sport',
});

function sportToken(value) {
    if (typeof value !== 'string') return '';
    return value.trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function canonicalSport(value) {
    const token = sportToken(value);
    if (!token) return '';
    return aliases[token] || token;
}

function canonicalFitSport(sport, subSport) {
    const primary = canonicalSport(sport);
    const primaryToken = sportToken(sport);
    const subToken = sportToken(subSport);
    if (!subToken || ['generic', 'all', 'none'].includes(subToken)) return primary;
    const secondary = canonicalSport(subSport);
    if ((['training', 'other', 'water-sport', 'winter-sport'].includes(primary) ||
        primaryToken === 'fitness_equipment') && secondary !== 'other') {
        return secondary;
    }
    return primary;
}

module.exports = { canonicalFitSport, canonicalSport, sportToken };
