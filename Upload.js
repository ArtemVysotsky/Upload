/**
 * Клас для роботи з завантаженням файлу
 *
 * @author      Артем Висоцький <a.vysotsky@gmail.com>
 * @link        https://github.com/ArtemVysotsky/Upload
 * @copyright   GNU General Public License v3
 */

/** ToDo: Перевірити роботу відновлення завантаження */
/** ToDo: Відрефакторити код */

class Upload {
    /**
     * @property {object}   #options                    - Налаштування класу
     * @property {string}   #options.url                - Адреса API для завантаження файлу
     * @property {object}   #options.chunkSize          - Налаштування розміру фрагмента файлу
     * @property {number}   #options.chunkSize.minimum  - Мінімальний розмір фрагмента файлу, байти
     * @property {number}   #options.chunkSize.maximum  - Максимальний розмір фрагмента файлу, байти
     * @property {number}   #options.fileSizeLimit      - Максимальний дозволений розмір файлу, байти
     * @property {number}   #options.interval           - Максимальний рекомендована тривалість запиту, секунди
     * @property {object}   #options.retry              - Налаштування повторних запитів
     * @property {number}   #options.retry.limit        - Максимальна кількість повторних запитів
     * @property {number}   #options.retry.interval     - Тривалість паузи між повторними запитами, секунди
     */
    #options = {
        url: 'api.php', chunkSize: {minimum: 1024, maximum: 20 * 1024 * 1024},
        fileSizeLimit: 1024 * 1024 * 1024, interval: 3, retry: {limit: 3, interval: 1}
    };

    /** @property {File} #file - Об'єкт файлу */
    #file;

    /** @property {string} #hash - Тимчасовий хеш файлу */
    #hash;

    /**
     * @property {object}   #chunk                  - Дані фрагмента файлу
     * @property {number}   #chunk.number           - Порядковий номер фрагмента файлу
     * @property {number}   #chunk.offset           - Зміщення від початку файлу, байти
     * @property {object}   #chunk.size             - Дані розміру фрагмента файлу, байти
     * @property {number}   #chunk.size.base        - Розмір бази фрагмента файлу, байти
     * @property {number}   #chunk.size.value       - Поточний розмір фрагмента файлу, байти
     * @property {number}   #chunk.size.coefficient - Коефіцієнт розміру фрагмента файлу (1|2)
     * @property {File}     #chunk.value            - Вміст фрагмента файлу (File)
     * @property {number}   #chunk.speed            - Швидкість виконання запиту, байти/с
     */
    #chunk = {number: 0, offset: 0, size: {base: 0, value: 0, coefficient: 1}, value: null, speed: 0};

    /**
     * @property {object}   #request        - Запит до сервера
     * @property {string}   #request.action - Тип запиту
     * @property {object}   #request.data   - Дані запиту
     */
    #request = {action: null, data: null};

    /**
     * @property {object} #timers           - Мітки часу
     * @property {number} #timers.start     - Час початку завантаження, секунди
     * @property {number} #timers.pause     - Час призупинки завантаження, секунди
     * @property {number} #timers.stop      - Час зупинки завантаження, секунди
     * @property {number} #timers.request   - Час перед початком виконання запиту, мілісекунди
     * @property {number} #timers.status    - Час попереднього запиту індикаторів процесу завантаження файлу, секунди
     */
    #timers = {start: null, pause: null, stop: null, request: null, status: null};

    /**
     * @property {object} #callbacks                - Зворотні функції
     * @property {function} #callbacks.iteration    - Дії при виконанні кожного запита на сервер
     * @property {function} #callbacks.pause        - Дії при призупинені процесу завантаження файлу
     * @property {function} #callbacks.timeout      - Дії при відсутності відповіді від сервера
     * @property {function} #callbacks.resolve      - Дії при завершені процесу завантаження файлу
     * @property {function} #callbacks.reject       - Дії при винекненні помилки під час процесу
     */
    #callbacks = {
        iteration: () => {}, pause: () => {}, timeout: () => {}, resolve: () => {}, reject: () => {}
    };

    /**
     * Конструктор
     * @param {File} file - Обє'ект з даними файлу
     * @param {object} callbacks - Зворотні функції
     */
    constructor(file, callbacks = {}) {
        if (file.size > this.#options.fileSizeLimit)
            throw new Error('Розмір файлу більше дозволеного');
        this.#file = file;
        this.#callbacks = {...callbacks};
    }

    /**
     * Починає процес завантаження файлу на сервер
     * @returns {Promise}
     */
    async start() {
        this.#timers.start = this.#getTime();
        await this.#open();
    }

    /**
     * Призупиняє процес завантаження файлу на сервер
     */
    pause() {this.#timers.pause = this.#getTime()}

    /**
     * Продовжує процес завантаження файлу на сервер
     * @returns {Promise}
     */
    async resume() {
        this.#timers.start =
            this.#getTime() - (this.#timers.pause - this.#timers.start);
        this.#timers.pause = null;
        switch (this.#request.action) {
            case 'open': this.#open(); break;
            case 'append': this.#append(); break;
            case 'close': this.#close(); break;
        }
    }

    /**
     * Скасовує процес завантаження файлу на сервер
     * @returns {Promise}
     */
    async cancel() {
        if (!this.#timers.pause) {
            await this.#remove();
        } else {
            this.#timers.stop = this.#getTime();
        }
    }

    /**
     * Відкриває файл для запису на сервері
     * @returns {Promise}
     * @see Upload.#request
     */
    #open = async () => {
        this.#request.action = 'open';
        this.#chunk.size.base = this.#options.chunkSize.minimum;
        const response = await this.#send();
        this.#hash = response.hash;
        this.#append();
    };

    /**
     * Додає фрагмент файлу на сервер
     * @returns {Promise}
     * @see Upload.#request
     */
    #append = async () => {
        this.#request.action = 'append';
        if (this.#timers.pause) {
            this.#callbacks.pause();
            this.#chunk.speed = 0;
            return;
        }
        if (this.#timers.stop) {
            this.#remove();
            return;
        }
        this.#chunk.number ++;
        this.#chunk.size.value =
            this.#chunk.size.base * this.#chunk.size.coefficient;
        this.#chunk.value =
            this.#file.slice(this.#chunk.offset, this.#chunk.offset + this.#chunk.size.value);
        this.#request.data = new FormData();
        this.#request.data.append('hash', this.#hash);
        this.#request.data.append('offset', this.#chunk.offset);
        this.#request.data.append('chunk', this.#chunk.value, this.#file.name);
        this.#timers.request = (new Date).getTime();
        const response = await this.#send();
        if (response === undefined) return;
        this.#chunk.offset = response.size;
        this.#sizing();
        if (this.#chunk.offset < this.#file.size) {
            this.#append();
        } else {
            this.#close();
        }
    };

    /**
     * Закриває файл на сервері
     * @throws {Error} - Неправельний розмір завантаженого файлу
     * @returns {Promise}
     * @see Upload.#request
     */
    #close = async () => {
        this.#request.action = 'close';
        this.#request.data = new FormData();
        this.#request.data.append('time', this.#file.lastModified);
        this.#request.data.append('hash', this.#hash);
        this.#chunk.speed = Math.round(this.#file.size / (this.#getTime() - this.#timers.start));
        this.#chunk.size.value = Math.round(this.#file.size / this.#chunk.number);
        const response = await this.#send();
        if (response === undefined) return;
        if (response.size !== this.#file.size)
            throw new Error('Неправильний розмір завантаженого файлу');
        await this.#callbacks.resolve();
    };

    /**
     * Видаляє файл на сервері
     * @returns {Promise}
     * @see Upload.#request
     */
    #remove = async () => {
        this.#request.action = 'remove';
        this.#request.data = (new FormData()).append('hash', this.#hash);
        await this.#send();
    };

    /**
     * Відправляє запит на сервер
     * @param {number} [retry = 1] - Кількіість повторних запитів
     * @returns {Promise}
     * @throws {Error} - Неправильний формат відповіді сервера
     * @see Upload.#request
     */
    #send = async (retry = 1) => {
        let response = {};
        const url = this.#options.url + '?action=' + this.#request.action + '&name=' + this.#file.name;
        try {
            response = await fetch(url, {method: 'POST', body: this.#request.data});
        } catch (e) {
            if (retry > this.#options.retry.limit) {
                this.pause();
                this.#callbacks.timeout();
                return;
            }
            console.warn('Повторний запит #' + retry);
            setTimeout(
                () => {this.#send(retry ++)},
                this.#options.retry.interval * 1000
            );
            return;
        }
        this.#request.data = null;
        this.#callbacks.iteration(this.#getStatus());
        let responseJSON;
        try {
            responseJSON = await response.json();
            if (response.ok) {
                return responseJSON;
            } else {
                let message = (response.status === 500)
                    ? ((responseJSON.error !== undefined) ? responseJSON.error : response.statusText)
                    : 'Під час виконання запиту "' + this.#request.action + '" виникла помилка';
                this.#callbacks.reject(Error(message));
            }
        } catch (e) {
            throw new Error('Неправильний формат відповіді сервера');
        }
    };

    /**
     *  Повертає мітку часу з врахуванням часової зони
     *  returns {number} - Мітка часу, секунди
     */
    #getTime = () => {
        return Math.round(
            ((new Date()).getTime() / 1000) - ((new Date()).getTimezoneOffset() * 60)
        );
    };

    /**
     * Вираховує та повертає дані про статус процесу завантаження файлу
     * @returns     {object}
     * @property    {object} size           - Розмір
     * @property    {number} size.bytes     - Розмір завантаженої частини файлу, байти
     * @property    {number} size.percent   - Розмір завантаженої частини файлу, відсотки
     * @property    {number} speed          - Швидкість завантаження, байти/секунду
     * @property    {number} chunk          - Розмір фрагмента файлу, байти
     * @property    {object} time           - Час
     * @property    {number} time.elapsed   - Минуло часу з початку процесу завантаження, секунди
     * @property    {number} time.estimate  - Розрахунковий час закінчення процесу завантаження, секунди
     */
    #getStatus = () => {
        let status = {chunk: this.#chunk.size.value, speed: this.#chunk.speed, time: {}, size: {}};
        status.time.elapsed = Math.round(this.#getTime() - this.#timers.start);
        if (this.#chunk.speed > 0) {
            status.time.estimate =
                this.#file.size / (this.#chunk.offset / status.time.elapsed);
            status.time.estimate =
                Math.round(status.time.estimate - status.time.elapsed);
        } else {
            status.time.estimate = 0;
        }
        status.size = {
            bytes: this.#chunk.offset,
            percent: Math.round(this.#chunk.offset * 100 / this.#file.size)
        };
        return status;
    };

    /**
     * Визначає базовий розмір та коєфіцієнт для наступгого фрагмента файлу
     * @see Upload.#chunk
     */
    #sizing = () => {
        let interval = ((new Date).getTime() - this.#timers.request) / 1000;
        let speed = Math.round(this.#chunk.size.value / interval);
        if (this.#chunk.size.coefficient === 2) {
            if ((interval < this.#options.interval) && (speed > this.#chunk.speed)) {
                if ((this.#chunk.size.base * 2) < this.#options.chunkSize.maximum)
                    this.#chunk.size.base *= 2;
            } else {
                if ((this.#chunk.size.base / 2) > this.#options.chunkSize.minimum)
                    this.#chunk.size.base /= 2;
            }
        }
        this.#chunk.speed = speed;
        this.#chunk.size.coefficient = 3 - this.#chunk.size.coefficient;
    };
}
