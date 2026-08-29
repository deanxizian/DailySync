import { Encoder, Profile } from '@garmin/fitsdk';

export function makeFit({ serial = 12345, start = new Date('2025-04-06T03:00:00Z'), records = 30, omitSerial = false, extra = false } = {}) {
    const encoder = new Encoder();
    encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 1,
        ...(omitSerial ? {} : { serialNumber: serial }), timeCreated: start });
    for (let i = 0; i < records; i++) {
        encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date(start.getTime() + i * 1000),
            positionLat: 100000000 + i * 10, positionLong: 200000000 + i * 10,
            distance: i * 3, heartRate: 130 + (i % 10), cadence: 80, ...(extra ? { temperature: 20 } : {}) });
    }
    encoder.onMesg(Profile.MesgNum.SESSION, { startTime: start, timestamp: new Date(start.getTime() + 1800000),
        sport: 'running', subSport: 'generic', totalTimerTime: 1800, totalElapsedTime: 1800, totalDistance: 5000 });
    return Buffer.from(encoder.close());
}
