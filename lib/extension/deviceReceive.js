const settings = require('../util/settings');
const logger = require('../util/logger');
const utils = require('../util/utils');
const debounce = require('debounce');
const BaseExtension = require('./baseExtension');

function cie_to_rgb(x, y, brightness) {
	//Set to maximum brightness if no custom value was given (Not the slick ECMAScript 6 way for compatibility reasons)
	if (brightness === undefined) {
		brightness = 254;
	}

	var z = 1.0 - x - y;
	var Y = (brightness / 254).toFixed(2);
	var X = (Y / y) * x;
	var Z = (Y / y) * z;

	//Convert to RGB using Wide RGB D65 conversion
	var red 	=  X * 1.656492 - Y * 0.354851 - Z * 0.255038;
	var green 	= -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
	var blue 	=  X * 0.051713 - Y * 0.121364 + Z * 1.011530;

	//If red, green or blue is larger than 1.0 set it back to the maximum of 1.0
	if (red > blue && red > green && red > 1.0) {

		green = green / red;
		blue = blue / red;
		red = 1.0;
	}
	else if (green > blue && green > red && green > 1.0) {

		red = red / green;
		blue = blue / green;
		green = 1.0;
	}
	else if (blue > red && blue > green && blue > 1.0) {

		red = red / blue;
		green = green / blue;
		blue = 1.0;
	}

	//Reverse gamma correction
	red 	= red <= 0.0031308 ? 12.92 * red : (1.0 + 0.055) * Math.pow(red, (1.0 / 2.4)) - 0.055;
	green 	= green <= 0.0031308 ? 12.92 * green : (1.0 + 0.055) * Math.pow(green, (1.0 / 2.4)) - 0.055;
	blue 	= blue <= 0.0031308 ? 12.92 * blue : (1.0 + 0.055) * Math.pow(blue, (1.0 / 2.4)) - 0.055;


	//Convert normalized decimal to decimal
	red 	= Math.round(red * 255);
	green 	= Math.round(green * 255);
	blue 	= Math.round(blue * 255);

	if (isNaN(red))
		red = 0;

	if (isNaN(green))
		green = 0;

	if (isNaN(blue))
		blue = 0;


	return [red, green, blue];
}


class DeviceReceive extends BaseExtension {
    constructor(zigbee, mqtt, state, publishEntityState) {
        super(zigbee, mqtt, state, publishEntityState);
        this.coordinator = null;
        this.elapsed = {};
        this.debouncers = {};
    }

    async onZigbeeStarted() {
        this.coordinator = this.zigbee.getDevicesByType('Coordinator')[0];
    }

    publishDebounce(ieeeAddr, payload, time) {
        if (!this.debouncers[ieeeAddr]) {
            this.debouncers[ieeeAddr] = {
                payload: {},
                publish: debounce(() => {
                    this.publishEntityState(ieeeAddr, this.debouncers[ieeeAddr].payload);
                    this.debouncers[ieeeAddr].payload = {};
                }, time * 1000),
            };
        }

        this.debouncers[ieeeAddr].payload = {...this.debouncers[ieeeAddr].payload, ...payload};
        this.debouncers[ieeeAddr].publish();
    }

    canHandleEvent(type, data, mappedDevice) {
        if (type !== 'message') {
            return false;
        }

        if (data.device.ieeeAddr === this.coordinator.ieeeAddr) {
            logger.debug('Ignoring message from coordinator');
            return false;
        }

        /**
         * Don't handle re-transmitted Xiaomi messages.
         * https://github.com/Koenkk/zigbee2mqtt/issues/1238
         *
         * Some Xiaomi router devices re-transmit messages from Xiaomi end devices.
         * The source address of these message is set to the one of the Xiaomi router.
         * Therefore it looks like if the message came from the Xiaomi router, while in
         * fact it came from the end device.
         * Handling these message would result in false state updates.
         * The group ID attribute of these message defines the source address of the end device.
         * As the same message is also received directly from the end device, it makes no sense
         * to handle these messages.
         */
        const hasGroupID = data.hasOwnProperty('groupID') && data.groupID != 0;
        if (utils.isXiaomiDevice(data.device) && utils.isRouter(data.device) && hasGroupID) {
            logger.debug('Skipping re-transmitted Xiaomi message');
            return false;
        }

        if (data.device.modelID === null && data.device.interviewing) {
            logger.debug(`Skipping message, modelID is undefined and still interviewing`);
            return false;
        }

        if (!mappedDevice) {
            logger.warn(`Received message from unsupported device with Zigbee model '${data.device.modelID}'`);
            logger.warn(`Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html.`);
            return false;
        }

        return true;
    }

    onZigbeeEvent(type, data, mappedDevice, settingsDevice) {
        if (!this.canHandleEvent(type, data, mappedDevice)) {
            return;
        }

        const converters = mappedDevice.fromZigbee.filter((c) => {
            const type = Array.isArray(c.type) ? c.type.includes(data.type) : c.type === data.type;
            return c.cluster === data.cluster && type;
        });

        // Check if there is an available converter
        if (!converters.length) {
            // Don't log readRsp and raw as warn messages, they are not interesting most of the time.
            const level = ['readResponse', 'raw'].includes(data.type) ? 'debug' : 'warn';
            logger[level](
                `No converter available for '${mappedDevice.model}' with cluster '${data.cluster}' ` +
                `and type '${data.type}' and data '${JSON.stringify(data.data)}'`,
            );
            return;
        }

        // Convert this Zigbee message to a MQTT message.
        // Get payload for the message.
        // - If a payload is returned publish it to the MQTT broker
        // - If NO payload is returned do nothing. This is for non-standard behaviour
        //   for e.g. click switches where we need to count number of clicks and detect long presses.
        const publish = (payload) => {
            // Add device linkquality.
            if (data.hasOwnProperty('linkquality')) {
                payload.linkquality = data.linkquality;
            }

            if (settings.get().advanced.elapsed) {
                const now = Date.now();
                if (this.elapsed[data.device.ieeeAddr]) {
                    payload.elapsed = now - this.elapsed[data.device.ieeeAddr];
                }

                this.elapsed[data.device.ieeeAddr] = now;
            }

            // Check if we have to debounce
            if (settingsDevice && settingsDevice.hasOwnProperty('debounce')) {
                this.publishDebounce(data.device.ieeeAddr, payload, settingsDevice.debounce);
            } else {
                this.publishEntityState(data.device.ieeeAddr, payload);

                if (settings.get().homeassistant) {
                    /**
                     * Publish an empty value for click and action payload, in this way Home Assistant
                     * can use Home Assistant entities in automations.
                     * https://github.com/Koenkk/zigbee2mqtt/issues/959#issuecomment-480341347
                     */
                    Object.keys(payload).forEach((key) => {
                        if (['action', 'click'].includes(key)) {
                            const counterPayload = {};
                            counterPayload[key] = '';
                            this.publishEntityState(data.device.ieeeAddr, counterPayload);
                        }
                    });
                }
            }
        };

        let payload = {};
        converters.forEach((converter) => {
            const options = {...settings.get().device_options, ...settings.getDevice(data.device.ieeeAddr)};
            const converted = converter.convert(mappedDevice, data, publish, options);
            if (converted) {
                payload = {...payload, ...converted};
            }
        });

        if (Object.keys(payload).length) {
            //If x/y color payload, add a "hex" attribute with the hex color
            if (payload.color && payload.color.x && payload.color.y){
              //if brightness is set, we use it. Otherwise it's left undefined and cie_to_rgb then assumes max brightness.
              var rgb = cie_to_rgb(payload.color.x, payload.color.y, payload.brightness);
              payload.color.hex = "#" + ((1 << 24) + (Math.round(rgb[0]*255) << 16) + (Math.round(rgb[1]*255) << 8) + Math.round(rgb[2]*255)).toString(16).slice(1);
            }
            publish(payload);
        }
    }
}

module.exports = DeviceReceive;
