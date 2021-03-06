import moment from 'moment';
import 'moment-timezone';
import cache from 'memory-cache';
import laMetric from "./laMetric";
import restClient from "./restClient";

const REAL_TIME_DEPARTURES_V4_KEY = process.env.REAL_TIME_DEPARTURES_V4_KEY;
const BASE_URL = 'http://api.sl.se/api2/realtimedeparturesV4.json?key=' + REAL_TIME_DEPARTURES_V4_KEY;
const TIME_WINDOW = 60;
const TEN_MINUTES = 600000;
const THIRTY_MINUTES = 1800000;
const TZ_STOCKHOLM = 'Europe/Stockholm';
const TIME_FORMAT = 'hh:mm:ss';

const RealTimeDeparture = {};
const departureCache = new cache.Cache();
const thresholdCache = new cache.Cache();

RealTimeDeparture.execute = (query) => {
    return new Promise((resolve, reject) => {
        const cachedJson = departureCache.get(query.getCacheKey());
        if (cachedJson !== null) {
            console.log('Found cached response for key: ' + query.getCacheKey());
            findTimeTilNextDeparture(cachedJson, query).then(response => {
                resolve(laMetric.createResponse(response, query.transportMode));
            }, error => {
                if (thresholdCache.get(query.getCacheKey()) === null) {
                    thresholdCache.put(query.getCacheKey(), 1, THIRTY_MINUTES);
                    console.log('thresholdCache size: ' + thresholdCache.size());
                    console.log('Failed to parse cached data, fetching new data', error);
                    queryForRealTimeDepartures(query, resolve, reject);
                } else {
                    console.log('Failed to parse cached data and threshold reached');
                    reject(laMetric.createError(error, query.transportMode));
                }
            });
        } else {
            queryForRealTimeDepartures(query, resolve, reject);
        }
    })
};

function queryForRealTimeDepartures(query, resolve, reject) {
    queryRealTimeDeparturesApi(query).then(response => {
        resolve(laMetric.createResponse(response, query.transportMode));
    }, error => {
        reject(laMetric.createError(error, query.transportMode));
    })
}

function queryRealTimeDeparturesApi(query) {
    return new Promise((resolve, reject) => {
        restClient.get(createRequest(query.siteId))
            .then(json => {
                if (json.StatusCode > 0) {
                    console.log(json);
                }
                departureCache.put(query.getCacheKey(), json, getCacheTime());
                console.log('departureCache size: ' + departureCache.size());
                findTimeTilNextDeparture(json, query).then(nextDepartureTime => {
                    resolve(nextDepartureTime);
                }, error => {
                    reject(error);
                })
            }, error => {
                console.log(error);
                reject('Misslyckades att hämta information från SL');
            });
    })
}

const findTimeTilNextDeparture = (json, query) => {
    return new Promise((resolve, reject) => {
        const transportModeResponseData = getTransportModeResponseData(json.ResponseData, query.transportMode);
        if (transportModeResponseData.length > 0) {
            const nextDeparture = findNextDeparture(transportModeResponseData, query);
            if (nextDeparture) {
                let departureTime = [`${calculateMinutesLeft(nextDeparture.ExpectedDateTime)} min`];
                if (query.displayLineNumber) {
                    departureTime = [`${nextDeparture.LineNumber}`, `${departureTime}`, `${nextDeparture.LineNumber}`, `${departureTime}`, `${nextDeparture.LineNumber}`, `${departureTime}`];
                }
                resolve(departureTime);
            } else {
                reject("inga avgångar");
            }
        } else {
            reject("inga avgångar för valt färdmedel");
        }
    })
};

const createRequest = (siteId) => {
    const request = `&siteid=${siteId}&timewindow=${TIME_WINDOW}&train=true&bus=true&metro=true&tram=true&ships=true`;
    console.log('Request: ' + request);
    return BASE_URL + request;
};

const calculateMinutesLeft = (expectedDepartureTime) => {
    const expectedDeparture = moment.tz(expectedDepartureTime, TZ_STOCKHOLM);
    const now = moment();
    const calc = moment.duration(expectedDeparture.diff(now));
    return calc.minutes();
};

const findNextDeparture = (responseData, query) => {
    let departures = responseData;
    if (query.lineNumbers.length > 0) {
        departures = responseData.filter(item => {
            return (query.lineNumbers.indexOf(item.LineNumber.toLowerCase()) > -1)
        });
    }

    return departures.sort((a, b) => {
        return moment(a.ExpectedDateTime) - moment(b.ExpectedDateTime);
    }).find((item) => {
        if (item.JourneyDirection === query.journeyDirection) {
            const minutesLeft = calculateMinutesLeft(item.ExpectedDateTime);
            return minutesLeft >= query.skipMinutes;
        }
        return false;
    });
};

const getTransportModeResponseData = (responseData, transportMode) => {
    switch (transportMode) {
        case 'train':
            return responseData.Trains || [];
        case 'bus':
            return responseData.Buses || [];
        case 'metro':
            return responseData.Metros || [];
        case 'tram':
            return responseData.Trams || [];
        case 'ships':
            return responseData.Ships || [];
        default:
            return [];
    }
};

const getCacheTime = () => {
    const currentTime = moment.tz(moment(), TZ_STOCKHOLM);
    const from = moment.tz(moment('05:00:00', TIME_FORMAT), TZ_STOCKHOLM);
    const to = moment.tz(moment('10:00:00', TIME_FORMAT), TZ_STOCKHOLM);
    if (currentTime.isBetween(from, to)) {
        console.log('10 minutes cache time');
        return TEN_MINUTES;
    }
    console.log('30 minutes cache time');
    return THIRTY_MINUTES;
};

export default RealTimeDeparture
