"use strict";

var app = null;

jQuery(document).ready(function() {
    $.backstretch("assets/img/backgrounds/1.jpg");
    
    $('#top-navbar-1').on('shown.bs.collapse', function(){
    	$.backstretch("resize");
    });
    $('#top-navbar-1').on('hidden.bs.collapse', function(){
    	$.backstretch("resize");
    });
    
    app = new App();
});

class App {
    constructor() {
        this.prepareTemplates();
        
        if ('serial' in navigator) {
            this.render(this.templates.welcome, null);
            this.loadBadges().catch((error) => { this.render(this.templates.error, error); });
        } else {
            this.render(this.templates.webserial, null);
        }
    }
    
    async loadBadges() {
        let response = await fetch('assets/badges.json');
        this.badges = await response.json();
        this.render(this.templates.select_badge, this.badges);
    }
    
    selectBadge() {
        this.badge = null;
        let id = document.getElementById("badge-type").value;
        for (let index = 0; index < this.badges.length; index++) {
            if (this.badges[index].id == id) {
                this.badge = this.badges[index];
                break;
            }
        }
        if (this.badge === null) {
            this.render(this.templates.error, "Failed to select badge.");
        } else {
            this.connect().catch((error) => { this.render(this.templates.error, error); });
        }
    }
    
    loaderLog(message) {
        console.log(message);
    }
    
    loaderError(message) {
        this.render(this.templates.error, message);
        console.error(message);
    }
    
    getChromeVersion() {
        let raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
        return raw ? parseInt(raw[2], 10) : false;
    }
    
    formatMacAddr(macAddr) {
        return macAddr.map(value => value.toString(16).toUpperCase().padStart(2, "0")).join(":");
    }
    
    toHex(value, size=4) {
        return "0x" + value.toString(16).toUpperCase().padStart(size, "0");
    }
    
    async reset() {
        console.log("Issue reset...");
        this.render(this.templates.message, {title: "Reset", message: "Resetting badge..."});
        await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, 1200));
        await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
        location.reload();
    }
    
    async connect() {
        this.port = await navigator.serial.requestPort();
        this.render(this.templates.message, {title: "Connection", message: "Please select the correct serial port."});
        if (this.getChromeVersion() < 86) {
            await this.port.open({ baudrate: ESP_ROM_BAUD });
        } else {
            await this.port.open({ baudRate: ESP_ROM_BAUD });
        }
        this.signals = await this.port.getSignals();
        this.render(this.templates.message, {title: "Connection", message: "Connected to the serial port."});
        this.outputStream = this.port.writable;
        this.inputStream = this.port.readable;
        inputBuffer = [];
        this.readLoop().catch((error) => {
            this.render(this.templates.disconnected, error);
        });
        this.espTool = new EspLoader(this.loaderLog.bind(this), this.loaderError.bind(this), this.port, this.badge.flashsize, this.writeToStream.bind(this));
        this.render(this.templates.message, {title: "Connection", message: "Connecting to the badge..."});
          try {
            if (await this.espTool.sync()) {
                if (this.badge.baudrate != ESP_ROM_BAUD) {
                    this.render(this.templates.message, {title: "Connection", message: "Changing baudrate..."});
                    await this.espTool.setBaudrate(this.badge.baudrate);
                }
                this.render(this.templates.message, {title: "Connection", message: "Connected to " + await this.espTool.chipName() + " (" + this.formatMacAddr(this.espTool.macAddr()) + "), loading stub..."});
                this.stubLoader = await this.espTool.runStub();
                await this.menu();
            } else {
                this.render(this.templates.error, "Failed to connect.");
            }
        } catch(error) {
            this.render(this.templates.error, error);
        }
    }
    
    async menu() {
        let chip = await this.stubLoader.chipName();
        let mac = this.formatMacAddr(this.stubLoader.macAddr());
        this.render(this.templates.menu, {
            name: this.badge.name,
            chip: chip,
            mac: mac
        });
    }
    
    async erase(sure=false) {
        if (!sure) {
            this.render(this.templates.erase, null);
            return;
        }
        try {
            this.render(this.templates.message, {title: "Erase flash", message: "Erasing flash memory. Please wait..."});
            let stamp = Date.now();
            await this.stubLoader.eraseFlash();
            this.render(this.templates.confirmation, {title: "Erase flash", message: "Finished. Took " + (Date.now() - stamp) + "ms to erase."});
        } catch(error) {
            this.render(this.templates.error, error);
        }
    }
    
    async getData(filename) {
        var request = new Request('assets/firmware/'+filename);
        var response = await fetch(request);
        return response.arrayBuffer();
    }
    
    showProgress(operation, progress = 0) {
        this.render(this.templates.message, {title: "Flashing...", message: "Writing "+operation.name+" to " + this.toHex(operation.address) + "... ("+progress+"%)"});
    }
    
    async flashFirmware() {
        try {
            let operations = this.badge.flash;
            for (let index = 0; index < operations.length; index++) {
                let operation = operations[index];
                this.render(this.templates.message, {title: "Flashing...", message: "Downloading "+operation.name+"..."});
                let data = await this.getData(operation.filename);
                this.showProgress(operation);
                await this.stubLoader.flashData(data, operation.address, this.showProgress.bind(this, operation));
            }
            this.render(this.templates.confirmation, {title: "Flash result", message: "Done."});
        } catch(error) {
            console.error(error);
            this.render(this.templates.error, error);
        }
    }
    
    async writeToStream(data) {
        const writer = this.outputStream.getWriter();
        await writer.write(new Uint8Array(data));
        writer.releaseLock();
    }
    
    async readLoop() {
        this.reader = this.port.readable.getReader();
        while (true) {
            const { value, done } = await this.reader.read();
            if (done) {
                this.reader.releaseLock();
                break;
            }
            inputBuffer = inputBuffer.concat(Array.from(value));
        }
    }

    prepareTemplates() {
        Handlebars.registerHelper({
        eq:     function (v1, v2)      { return v1 === v2; },
        ne:     function (v1, v2)      { return v1 !== v2; },
        lt:     function (v1, v2)      { return v1 < v2;   },
        gt:     function (v1, v2)      { return v1 > v2;   },
        lte:    function (v1, v2)      { return v1 <= v2;  },
        gte:    function (v1, v2)      { return v1 >= v2;  },
        and:    function ()            { return Array.prototype.slice.call(arguments).every(Boolean); },
        or:     function ()            { return Array.prototype.slice.call(arguments, 0, -1).some(Boolean); },
        list:   function (v1)          { return Array.isArray(v1); },
        string: function (v1)          { return (typeof v1 === 'string'); },
        isset:  function (v1)          { return (typeof v1 !== 'undefined'); },
        isin:   function (list, value) { return list.includes(value); },
        isinobjinlist: function (list, value, key) {
            for (var i in list) {
            var item = list[i];
            if (item[key] === value) return true;
            }
            return false;
        }
        });

        Handlebars.registerHelper('replaceNewlines', (text) => {
            if (typeof text === "string") {
                text = Handlebars.Utils.escapeExpression(text);
                return new Handlebars.SafeString(text.split("\n").join("<br />"));
            }
            return text;
        });

        Handlebars.registerHelper('nextId', () => {
            app.currId += 1;
            return app.currId;
        });

        Handlebars.registerHelper('currId', () => {
            return app.currId;
        });
        
        /*Handlebars.registerPartial('content-header', document.getElementById("tpl-content-header").innerHTML);
        Handlebars.registerPartial('content', document.getElementById("tpl-content").innerHTML);
        Handlebars.registerPartial('row', document.getElementById("tpl-row").innerHTML);
        Handlebars.registerPartial('col', document.getElementById("tpl-col").innerHTML);
        Handlebars.registerPartial('card', document.getElementById("tpl-card").innerHTML);
        Handlebars.registerPartial('table', document.getElementById("tpl-table").innerHTML);
        Handlebars.registerPartial('button', document.getElementById("tpl-button").innerHTML);
        Handlebars.registerPartial('element', document.getElementById("tpl-element").innerHTML);*/

        this.templates = {
            webserial: Handlebars.compile(document.getElementById("tpl-webserial").innerHTML),
            welcome: Handlebars.compile(document.getElementById("tpl-welcome").innerHTML),
            select_badge: Handlebars.compile(document.getElementById("tpl-select-badge").innerHTML),
            error: Handlebars.compile(document.getElementById("tpl-error").innerHTML),
            message: Handlebars.compile(document.getElementById("tpl-message").innerHTML),
            disconnected: Handlebars.compile(document.getElementById("tpl-disconnected").innerHTML),
            menu: Handlebars.compile(document.getElementById("tpl-menu").innerHTML),
            erase: Handlebars.compile(document.getElementById("tpl-erase").innerHTML),
            confirmation: Handlebars.compile(document.getElementById("tpl-confirmation").innerHTML),
        };
    }
    
    render(template, parameters) {
        document.getElementById("application").innerHTML = template(parameters);
    }
  
    bar_progress(progress_line_object, direction) {
        var number_of_steps = progress_line_object.data('number-of-steps');
        var now_value = progress_line_object.data('now-value');
        var new_value = 0;
        if(direction == 'right') {
            new_value = now_value + ( 100 / number_of_steps );
        }
        else if(direction == 'left') {
            new_value = now_value - ( 100 / number_of_steps );
        }
        progress_line_object.attr('style', 'width: ' + new_value + '%;').data('now-value', new_value);
    }
}
