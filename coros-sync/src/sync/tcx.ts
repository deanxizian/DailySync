import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { Activity, Evidence } from './types';
import { SyncError } from './errors';

const TCX_NAMESPACE = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
const TCX_SCHEMA = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd';
const ACTIVITY_EXTENSION_NAMESPACE = 'http://www.garmin.com/xmlschemas/ActivityExtension/v2';
const MAX_TRACK_POINTS = 500000;

interface Point {
    time: number;
    latitude: number;
    longitude: number;
    elevation?: number;
    heartRate?: number;
    cadence?: number;
    temperature?: number;
    power?: number;
    distance: number;
}

function list<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function number(value: unknown): number | undefined {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value))) return undefined;
    return Number(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
    const parsed = number(value);
    if (parsed === undefined || parsed < minimum || parsed > maximum) return undefined;
    return Math.round(parsed);
}

function utcTime(value: unknown): number {
    if (typeof value !== 'string' || !/[zZ]|[+-]\d\d:\d\d$/.test(value)) throw new Error();
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error();
    return parsed;
}

function parseXml(bytes: Buffer, code: 'GPX_INVALID' | 'TCX_INVALID'): any {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { throw new SyncError(code, `${code === 'GPX_INVALID' ? 'GPX' : 'TCX'} is not valid UTF-8 XML.`); }
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true) {
        throw new SyncError(code, `${code === 'GPX_INVALID' ? 'GPX' : 'TCX'} XML is invalid.`);
    }
    try {
        return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
            parseTagValue: false, trimValues: true, processEntities: false, ignoreDeclaration: true }).parse(text);
    } catch (_) {
        throw new SyncError(code, `${code === 'GPX_INVALID' ? 'GPX' : 'TCX'} XML cannot be parsed.`);
    }
}

function haversine(a: Point, b: Point): number {
    const radians = Math.PI / 180;
    const latitude = (b.latitude - a.latitude) * radians;
    const longitude = (b.longitude - a.longitude) * radians;
    const first = Math.sin(latitude / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) *
        Math.sin(longitude / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(first), Math.sqrt(Math.max(0, 1 - first)));
}

function gpxSegments(root: any): Point[][] {
    const segments: Point[][] = [];
    let count = 0;
    let previousTime = 0;
    for (const track of list<any>(root?.gpx?.trk)) {
        for (const segment of list<any>(track?.trkseg)) {
            const points: Point[] = [];
            for (const row of list<any>(segment?.trkpt)) {
                const latitude = number(row?.lat);
                const longitude = number(row?.lon);
                const time = utcTime(row?.time);
                if (latitude === undefined || longitude === undefined || latitude < -90 || latitude > 90 ||
                    longitude < -180 || longitude > 180 || time <= previousTime || ++count > MAX_TRACK_POINTS) throw new Error();
                previousTime = time;
                const extension = row?.extensions?.TrackPointExtension ?? row?.extensions ?? {};
                const elevation = number(row?.ele);
                const temperature = number(extension?.atemp ?? extension?.temp);
                const heartRate = boundedInteger(extension?.hr, 1, 255);
                const cadence = boundedInteger(extension?.cad, 0, 255);
                const power = boundedInteger(extension?.power ?? row?.extensions?.power, 0, 65535);
                points.push({ time, latitude, longitude, distance: 0,
                    ...(elevation === undefined ? {} : { elevation }),
                    ...(temperature === undefined || temperature < -100 || temperature > 100 ? {} : { temperature }),
                    ...(heartRate === undefined ? {} : { heartRate }),
                    ...(cadence === undefined ? {} : { cadence }),
                    ...(power === undefined ? {} : { power }),
                });
            }
            if (points.length) segments.push(points);
        }
    }
    if (!segments.length || count < 2) throw new Error();
    return segments;
}

function rounded(value: number, precision = 3): number {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

function trackpoint(point: Point, running: boolean): Record<string, any> {
    const extension: Record<string, any> = {};
    if (point.temperature !== undefined) extension['ns3:Temp'] = rounded(point.temperature, 1);
    if (running && point.cadence !== undefined) extension['ns3:RunCadence'] = point.cadence;
    if (point.power !== undefined) extension['ns3:Watts'] = point.power;
    const result: Record<string, any> = {
        Time: new Date(point.time).toISOString(),
        Position: { LatitudeDegrees: rounded(point.latitude, 8), LongitudeDegrees: rounded(point.longitude, 8) },
        ...(point.elevation === undefined ? {} : { AltitudeMeters: rounded(point.elevation) }),
        DistanceMeters: rounded(point.distance),
        ...(point.heartRate === undefined ? {} : {
            HeartRateBpm: { '@_xsi:type': 'HeartRateInBeatsPerMinute_t', Value: point.heartRate },
        }),
        ...(point.cadence === undefined || running ? {} : { Cadence: point.cadence }),
    };
    if (Object.keys(extension).length) result.Extensions = { 'ns3:TPX': extension };
    return result;
}

export function gpxToTcx(bytes: Buffer, activity: Activity): Buffer {
    if (!['cycling', 'running'].includes(activity.sport)) {
        throw new SyncError('GPX_UNSUPPORTED', `GPX conversion does not support ${activity.sport}.`);
    }
    let segments: Point[][];
    try { segments = gpxSegments(parseXml(bytes, 'GPX_INVALID')); }
    catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('GPX_INVALID', 'GPX must contain ordered UTC track points with valid coordinates.');
    }
    const points = segments.reduce<Point[]>((result, segment) => result.concat(segment), []);
    if (!Number.isFinite(activity.start) || activity.start <= 0 || Math.abs(points[0].time - activity.start) > 60000) {
        throw new SyncError('GPX_INVALID', 'GPX start time does not match the Garmin activity.');
    }
    // Keep point intervals intact while making the Garmin summary authoritative for duplicate detection.
    const timeShift = activity.start - points[0].time;
    for (const point of points) point.time += timeShift;

    let computedDistance = 0;
    for (const segment of segments) {
        for (let index = 0; index < segment.length; index++) {
            if (index) computedDistance += haversine(segment[index - 1], segment[index]);
            segment[index].distance = computedDistance;
        }
    }
    const totalDistance = activity.distance ?? computedDistance;
    if (!Number.isFinite(totalDistance) || totalDistance < 0) throw new SyncError('GPX_INVALID', 'GPX distance is invalid.');
    if (computedDistance > 0) {
        const scale = totalDistance / computedDistance;
        for (const point of points) point.distance *= scale;
    }
    const elapsed = (points[points.length - 1].time - points[0].time) / 1000;
    const duration = activity.duration ?? elapsed;
    if (!Number.isFinite(duration) || duration <= 0) throw new SyncError('GPX_INVALID', 'GPX duration is invalid.');

    const start = new Date(points[0].time).toISOString();
    const document = {
        '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
        TrainingCenterDatabase: {
            '@_xmlns': TCX_NAMESPACE,
            '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
            '@_xmlns:ns3': ACTIVITY_EXTENSION_NAMESPACE,
            '@_xsi:schemaLocation': `${TCX_NAMESPACE} ${TCX_SCHEMA}`,
            Activities: {
                Activity: {
                    '@_Sport': activity.sport === 'cycling' ? 'Biking' : 'Running',
                    Id: start,
                    Lap: {
                        '@_StartTime': start,
                        TotalTimeSeconds: rounded(duration),
                        DistanceMeters: rounded(totalDistance),
                        Calories: 0,
                        Intensity: 'Active',
                        TriggerMethod: 'Manual',
                        Track: segments.map(segment => ({
                            Trackpoint: segment.map(point => trackpoint(point, activity.sport === 'running')),
                        })),
                    },
                },
            },
        },
    };
    try {
        return Buffer.from(new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_',
            format: false, suppressEmptyNode: true }).build(document));
    } catch (_) {
        throw new SyncError('GPX_INVALID', 'GPX could not be converted to TCX.');
    }
}

export function tcxEvidence(bytes: Buffer): Evidence {
    try {
        const root = parseXml(bytes, 'TCX_INVALID');
        const activities = list<any>(root?.TrainingCenterDatabase?.Activities?.Activity);
        if (activities.length !== 1) throw new Error();
        const activity = activities[0];
        const sport = activity?.Sport === 'Biking' ? 'cycling' : activity?.Sport === 'Running' ? 'running' : undefined;
        const laps = list<any>(activity?.Lap);
        const points = laps.reduce<any[]>((all, lap) => all.concat(
            list<any>(lap?.Track).reduce<any[]>((trackPoints, track) => trackPoints.concat(list<any>(track?.Trackpoint)), [])), []);
        const start = points.length ? utcTime(points[0]?.Time) : utcTime(activity?.Id);
        const duration = laps.reduce((sum, lap) => sum + (number(lap?.TotalTimeSeconds) ?? NaN), 0);
        const distance = laps.reduce((sum, lap) => sum + (number(lap?.DistanceMeters) ?? NaN), 0);
        if (!sport || !laps.length || !points.length || !Number.isFinite(duration) || duration <= 0 ||
            !Number.isFinite(distance) || distance < 0) throw new Error();
        return { sha256: createHash('sha256').update(bytes).digest('hex'), start, sport, duration, distance };
    } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('TCX_INVALID', 'TCX must contain one complete running or cycling activity.');
    }
}
