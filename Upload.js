/**
 * Клас для роботи з завантаженням файла
 *
 * @author      Артем Висоцький <a.vysotsky@gmail.com>
 * @link        https://github.com/ArtemVysotsky/Upload
 * @copyright   GNU General Public License v3
 */

/** @typedef {object} jqXHR **/
/** @typedef {object} jqXHR.responseJSON **/

class Upload {
    #url = 'api.php'; // адреса API для завантаження файлу
    #options = {
        chunkSize: {minimum: 1024, maximum: 20 * 1024 * 1024}, // максимальний розмір фрагмента файлу, байти
        fileSizeLimit: 2 * 1024 * 1024 * 1024, // максимальний розмір файлу, байти
        interval: 3, // максимальний рекомендований час тривалості запиту, секунди
        timeout: 20, // максимальний дозволений час тривалості запиту, секунди
        retry: { //
            limit: 3, // максимальна кількість повторних запитів
            interval: 1 // тривалість паузи між повторними запитами, секунди
        }
    };
    #file = { // об'єкт файлу
        name: null, // назва файлу
        size: null, // розмір файлу, байти
        hash: null, // хеш файлу
        lastModified: null, // дата файлу
    };
    #chunk = { // поточна частина файлу
        number: 0, // порядковий номер фрагмента файлу
        offset: 0, // зміщення від початку файлу, байти
        size: {
            base: 0, // розмір бази фрагмента файлу, байти
            value: 0, // поточний розмір фрагмента файлу, байти
            multiplier: 1 // коефіцієнт для визначення поточного розміру фрагмента файла (1|2)
        },
    };
    #timers = { // часові мітки
        start: 0, // час початку завантаження, секунди
        pause: 0, // час призупинки завантаження, секунди
        stop: 0, // час зупинки завантаження, секунди
        status: 0 // час попереднього запиту індикаторів процесу завантаження файла, секунди
    };
    #speed = 0; // швидкість завантаження останнього фрагмента файлу, байти/с
    #retry = 0; // порядковий номер поточного повторного запиту
    #action = null; // поточна дія для запиту до сервера
    #callbacks = {
        iteration: () => {}, // дій після виконання кожного запита на сервер
        pause: () => {}, // дії при призупинені процесу завантаження файла
        timeout: () => {}, // дій при перевищенні обмеження для часу запиту
        finish: () => {}, // дій при завершені процесу завантаження файла
    };

    set file(file) {
        if (file.size > this.#options.fileSizeLimit)
            throw new Error('Розмір файлу більше дозволеного');
        this.#file = file;
    }

    set callbacks(callbacks) {
        if (callbacks.iteration !== undefined)  this.#callbacks.iteration = callbacks.iteration;
        if (callbacks.pause !== undefined)      this.#callbacks.pause = callbacks.pause;
        if (callbacks.timeout !== undefined)    this.#callbacks.timeout = callbacks.timeout;
        if (callbacks.finish !== undefined)     this.#callbacks.finish = callbacks.finish;
     }

    get time() {
        return Math.round(((new Date()).getTime() / 1000) - ((new Date()).getTimezoneOffset() * 60));
    }

    get size() {
        return {bytes: this.#chunk.offset, percent: Math.round(this.#chunk.offset * 100 / this.#file.size)};
    }

    get status() {
        let status = {chunk: this.#chunk.size.value, speed: this.#speed, time: {}};
        status.time.elapsed = Math.round(this.time - this.#timers.start);
        if (this.#speed > 0) {
            status.time.estimate = this.#file.size / (this.#chunk.offset / status.time.elapsed);
            status.time.estimate = Math.round(status.time.estimate - status.time.elapsed);
        } else {
            status.time.estimate = 0;
        }
        return status;
    };

    async start() {
        if (!(this.#file instanceof File)) throw new Error('Відсутній файл');
        this.#timers.start = this.time;
        await this.#open();
    }

    pause() {this.#timers.pause = this.time}

    async resume() {
        this.#timers.start = this.time - (this.#timers.pause - this.#timers.start);
        this.#timers.pause = 0;
        switch (this.#action) {
            case 'open': await this.#open(); break;
            case 'append': await this.#append(); break;
            case 'close': await this.#close(); break;
        }
    }

    async cancel() {
        if (this.#timers.pause > 0) {
            await this.#remove();
        } else {
            this.#timers.stop = this.time;
        }
    }

    #open = async () => {
        this.#action = 'open';
        this.#chunk.size.base = this.#options.chunkSize.minimum;
        const response = await this.#request('open');
        this.#file.hash = response.hash;
        this.#append();
    };

    #append = async () => {
        this.#action = 'append';
        if (this.#timers.pause > 0) {
            this.#callbacks.pause();
            this.#speed = 0;
            return;
        }
        if (this.#timers.stop > 0) {
            this.#remove();
            return;
        }
        this.#chunk.number ++;
        this.#chunk.size.value = this.#chunk.size.base * this.#chunk.size.multiplier;
        let chunk = this.#file.slice(this.#chunk.offset, this.#chunk.offset + this.#chunk.size.value);
        let data = new FormData();
        data.append('hash', this.#file.hash);
        data.append('offset', this.#chunk.offset);
        data.append('chunk', chunk, this.#file.name);
        let timestamp = (new Date()).getTime();
        const response = await this.#request('append', data);
        this.#chunk.offset = response.size;
        this.#sizing(timestamp);
        if (this.#chunk.offset < this.#file.size) {
            this.#append();
        } else {
            this.#close();
        }
    };

    #close = async () => {
        this.#action = 'close';
        let data = new FormData();
        data.append('time', this.#file.lastModified);
        data.append('hash', this.#file.hash);
        const response = await this.#request('close', data);
        if (response.size !== this.#file.size)
            throw new Error('Неправельний розмір завантаженого файлу');
        this.#speed = Math.round(this.#file.size / (this.time - this.#timers.start));
        this.#chunk.size.value = Math.round(this.#file.size / this.#chunk.number);
        await this.#callbacks.finish();
    };

    #remove = async () => {
        let data = new FormData();
        data.append('hash', this.#file.hash);
        await this.#request('remove', data);
    };

    #request = async (action, data = new FormData()) => {
        let response = {};
        const url = this.#url + '?action=' + action + '&name=' + this.#file.name;
        try {
            response = await fetch(url, {method: 'POST', body: data});
        } catch (e) {
            this.#retry ++;
            this.#chunk.size.base /= 2;
            if (this.#retry > this.#options.retry.limit) {
                this.#retry = 0;
                this.#chunk.size.multiplier = 1;
                this.#chunk.size.base = this.#options.chunkSize.minimum;
                this.pause();
                this.#callbacks.timeout(action);
                return;
            }
            console.warn('Повторний запит #' + this.#retry + ' / ' + human.time(this.time));
            setTimeout(
                () => {
                    switch (this.#action) {
                        case 'open': this.#open(); break;
                        case 'append': this.#append(); break;
                        case 'close': this.#close(); break;
                    }
                },
                this.#options.retry.interval * 1000);
        }
        this.#callbacks.iteration(this.status);
        const responseJSON = await response.json();
        if (response.ok) {
            return responseJSON;
        } else {
            const message = ((response.status === 500) && (responseJSON.exception !== undefined))
                ? response.statusText + ': ' + responseJSON.exception
                : 'Під час виконання запиту "' + action + '" виникла помилка';
            throw new Error(message);
        }
    };

    #sizing = (timestamp) => {
        let interval = ((new Date()).getTime() - timestamp) / 1000;

        let speed = Math.round(this.#chunk.size.value / interval);
//console.log(this.#chunk.number, this.#chunk.size, human.size(speed)+'/с', interval);

        if (this.#chunk.size.multiplier === 2) {
            if ((interval < this.#options.interval) && (speed > this.#speed)) {
                if ((this.#chunk.size.base * 2) < this.#options.chunkSize.maximum) this.#chunk.size.base *= 2;
            } else {
                if ((this.#chunk.size.base / 2) > this.#options.chunkSize.minimum) this.#chunk.size.base /= 2;
            }
        }

        this.#speed = speed;
        this.#chunk.size.multiplier = 3 - this.#chunk.size.multiplier;
    };
}
